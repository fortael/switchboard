// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//   Phase 4 (Summary):          After the loop, one agent writes an end-of-run
//                               report (what landed, what failed, next steps)
//                               to .sandcastle/logs/summary-<timestamp>.md.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Run log — fed to the final summary agent
// ---------------------------------------------------------------------------

type IssueOutcome = "committed" | "no-commits" | "failed";
type IssueRecord = {
  id: string;
  title: string;
  branch: string;
  outcome: IssueOutcome;
  commits: string[];
  error?: string;
};
type IterationRecord = {
  iteration: number;
  issues: IssueRecord[];
  merged: boolean;
};

const startSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const runLog: IterationRecord[] = [];
let stopReason = `reached MAX_ITERATIONS (${MAX_ITERATIONS})`;

// ---------------------------------------------------------------------------
// Main loop
//
// Wrapped in try/catch so an aborted run (planner output invalid, merger
// crash, ...) still ends with the summary phase.
// ---------------------------------------------------------------------------

try {
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

    // -------------------------------------------------------------------------
    // Phase 1: Plan
    //
    // The planning agent (opus, for deeper reasoning) reads the open issue list,
    // builds a dependency graph, and selects the issues that can be worked in
    // parallel right now (i.e., no blocking dependencies on other open issues).
    //
    // It outputs a <plan> JSON block — Output.object parses and validates it.
    // -------------------------------------------------------------------------
    const plan = await sandcastle.run({
      hooks,
      sandbox: docker(),
      name: "planner",
      // One iteration is enough: the planner just needs to read and reason,
      // not write code. (Structured output requires maxIterations: 1.)
      maxIterations: 1,
      // Opus for planning: dependency analysis benefits from deeper reasoning.
      agent: sandcastle.claudeCode("claude-opus-4-8"),
      promptFile: "./.sandcastle/plan-prompt.md",
      // Extract and validate the <plan> JSON into a typed object. Throws
      // StructuredOutputError if the tag is missing, the JSON is malformed, or
      // validation fails — which aborts the loop.
      output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
    });

    const issues = plan.output.issues;

    if (issues.length === 0) {
      // No unblocked work — either everything is done or everything is blocked.
      console.log("No unblocked issues to work on. Exiting.");
      stopReason = "no unblocked issues left";
      break;
    }

    console.log(
      `Planning complete. ${issues.length} issue(s) to work in parallel:`,
    );
    for (const issue of issues) {
      console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
    }

    // -------------------------------------------------------------------------
    // Phase 2: Execute + Review
    //
    // For each issue, create a sandbox via createSandbox() so the implementer
    // and reviewer share the same sandbox instance per branch. The implementer
    // runs first; if it produces commits, the reviewer runs in the same sandbox.
    //
    // Promise.allSettled means one failing pipeline doesn't cancel the others.
    // -------------------------------------------------------------------------

    const settled = await Promise.allSettled(
      issues.map(async (issue) => {
        const sandbox = await sandcastle.createSandbox({
          branch: issue.branch,
          sandbox: docker(),
          hooks,
          copyToWorktree,
        });

        try {
          // Run the implementer
          const implement = await sandbox.run({
            name: "implementer",
            maxIterations: 100,
            agent: sandcastle.claudeCode("claude-opus-4-8"),
            promptFile: "./.sandcastle/implement-prompt.md",
            promptArgs: {
              TASK_ID: issue.id,
              ISSUE_TITLE: issue.title,
              BRANCH: issue.branch,
            },
          });

          // Only review if the implementer produced commits
          if (implement.commits.length > 0) {
            const review = await sandbox.run({
              name: "reviewer",
              maxIterations: 1,
              agent: sandcastle.claudeCode("claude-opus-4-8"),
              promptFile: "./.sandcastle/review-prompt.md",
              promptArgs: {
                BRANCH: issue.branch,
              },
            });

            // Merge commits from both runs so the merge phase sees all of them.
            // Each sandbox.run() only returns commits from its own run.
            return {
              ...review,
              commits: [...implement.commits, ...review.commits],
            };
          }

          return implement;
        } finally {
          await sandbox.close();
        }
      }),
    );

    // Log any agents that threw (network error, sandbox crash, etc.).
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "rejected") {
        console.error(
          `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
        );
      }
    }

    const record: IterationRecord = {
      iteration,
      merged: false,
      issues: settled.map((outcome, i) => {
        const issue = issues[i]!;
        if (outcome.status === "rejected") {
          return {
            ...issue,
            outcome: "failed",
            commits: [],
            error: String(outcome.reason),
          };
        }
        const commits = outcome.value.commits.map((c) => c.sha.slice(0, 7));
        return {
          ...issue,
          outcome: commits.length > 0 ? "committed" : "no-commits",
          commits,
        };
      }),
    };
    runLog.push(record);

    // Only pass branches that actually produced commits to the merge phase.
    // An agent that ran successfully but made no commits has nothing to merge.
    const completedIssues = settled
      .map((outcome, i) => ({ outcome, issue: issues[i]! }))
      .filter(
        (entry) =>
          entry.outcome.status === "fulfilled" &&
          entry.outcome.value.commits.length > 0,
      )
      .map((entry) => entry.issue);

    const completedBranches = completedIssues.map((i) => i.branch);

    console.log(
      `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
    );
    for (const branch of completedBranches) {
      console.log(`  ${branch}`);
    }

    if (completedBranches.length === 0) {
      // All agents ran but none made commits — nothing to merge this cycle.
      console.log("No commits produced. Nothing to merge.");
      continue;
    }

    // -------------------------------------------------------------------------
    // Phase 3: Merge
    //
    // One agent merges all completed branches into the current branch,
    // resolving any conflicts and running tests to confirm everything works.
    //
    // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
    // uses to know which branches to merge and which issues to close.
    // -------------------------------------------------------------------------
    await sandcastle.run({
      hooks,
      sandbox: docker(),
      name: "merger",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-opus-4-8"),
      promptFile: "./.sandcastle/merge-prompt.md",
      promptArgs: {
        // A markdown list of branch names, one per line.
        BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
        // A markdown list of issue IDs and titles, one per line.
        ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
      },
    });

    record.merged = true;
    console.log("\nBranches merged.");
  }
} catch (error) {
  stopReason = `aborted: ${error}`;
  console.error(`\nRun aborted: ${error}`);
}

// ---------------------------------------------------------------------------
// Phase 4: Summary
//
// One read-only agent turns the run log + git history + tracker state into a
// human-facing report: what landed, what failed and why, what to do next.
// ---------------------------------------------------------------------------
function formatIssueRecord(i: IssueRecord): string {
  let detail = "";
  if (i.outcome === "failed") detail = ` — ${i.error}`;
  else if (i.outcome === "committed") detail = ` — ${i.commits.join(", ")}`;
  return `  - ${i.id} (${i.branch}) [${i.outcome}] ${i.title}${detail}`;
}

const runLogMarkdown =
  runLog.length === 0
    ? "_No iteration executed any issue._"
    : runLog
        .map(({ iteration, issues, merged }) => {
          const hasCommits = issues.some((i) => i.outcome === "committed");
          let status = "nothing to merge";
          if (hasCommits)
            status = merged ? "merged into current branch" : "NOT merged";
          return [
            `- Iteration ${iteration} (${status}):`,
            ...issues.map(formatIssueRecord),
          ].join("\n");
        })
        .join("\n");

const rawRunLog = `Stop reason: ${stopReason}\n\n${runLogMarkdown}`;

// Fall back to the raw run log if the summarizer itself fails.
let summaryText: string;
try {
  const summary = await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "summarizer",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-opus-4-8"),
    promptFile: "./.sandcastle/summary-prompt.md",
    promptArgs: { RUN_LOG: rawRunLog, START_SHA: startSha },
    output: sandcastle.Output.string({ tag: "summary" }),
  });
  summaryText = summary.output;
} catch (error) {
  console.error(`\nSummarizer failed: ${error}`);
  summaryText = `# Run log (summarizer failed)\n\n${rawRunLog}`;
}

const summaryPath = `.sandcastle/logs/summary-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
mkdirSync(".sandcastle/logs", { recursive: true });
writeFileSync(summaryPath, summaryText);

console.log(
  `\n=== Run summary ===\n\n${summaryText}\n\nSaved to ${summaryPath}`,
);
console.log("\nAll done.");
