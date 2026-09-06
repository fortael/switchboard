// Epic orchestrator: `npm run sandcastle [VIN-XXX]` drives one Linear epic to a single draft PR.
// Every decision (root, plan, code, verdicts, merge, summary) is made by an agent through a
// prompt in this folder; this file only sequences them and does host-side git/gh transport.
//
// Flow: select-root → bootstrap integration branch + draft PR → loop { plan → issues in
// parallel (implement → review/fix) → merge } → epic review/fix → summary → PR body.
// Idempotent: branches, worktrees and Linear state survive a crash, the next run resumes.

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { z } from "zod";

const MODEL = "claude-opus-4-8";
const MAX_ITERATIONS = 10;
const MAX_REVIEW_ROUNDS = 3;
const IMPLEMENT_ITERATIONS = 100;
const FIX_ITERATIONS = 20;
const DIR = ".sandcastle";
const LOCK = `${DIR}/run.lock`;

const agent = sandcastle.claudeCode(MODEL);
const hooks = { sandbox: { onSandboxReady: [{ command: "npm install" }] } };
const copyToWorktree = ["node_modules"];
const promptFile = (name: string) => `${DIR}/${name}-prompt.md`;

const rootSchema = z.object({
  id: z.string(),
  title: z.string(),
  branch: z.string(),
  prTitle: z.string(),
  prBody: z.string(),
}).nullable();
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
  done: z.boolean(),
  notes: z.string().optional(),
});
const reviewSchema = z.object({
  verdict: z.enum(["approve", "changes"]),
  notes: z.string(),
});

// ---------------------------------------------------------------------------
// Host helpers
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "inherit"],
  }).trim();
}

function ok(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const git = (...args: string[]) => run("git", args);
const gitOk = (...args: string[]) => ok("git", args);

function commitsAhead(base: string, branch: string): number {
  try {
    return Number(git("rev-list", "--count", `${base}..${branch}`));
  } catch {
    return 0;
  }
}

// Same rules as sandcastle's Output helpers: last tag wins, code fences unwrapped.
function lastTag(stdout: string, tag: string): string {
  const matches = [
    ...stdout.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g")),
  ];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) throw new Error(`<${tag}> missing in agent output`);
  return raw.trim().replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
}

function parseTag<T>(stdout: string, tag: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(lastTag(stdout, tag)));
}

const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

// launchd fires hourly; a run can outlast that, so refuse to overlap.
function acquireLock(): void {
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) {
      console.log(`Another run is active (pid ${pid}). Exiting.`);
      process.exit(0);
    }
  }
  writeFileSync(LOCK, String(process.pid));
  process.on("exit", () => rmSync(LOCK, { force: true }));
}

// ---------------------------------------------------------------------------
// Run log — fed to the summary agent
// ---------------------------------------------------------------------------

type IssueRecord = {
  id: string;
  title: string;
  branch: string;
  outcome: "progress" | "no-progress" | "failed";
  ahead: number;
  reviews: string[];
  error?: string;
};
type IterationRecord = {
  iteration: number;
  issues: IssueRecord[];
  merged: boolean;
};

const runLog: IterationRecord[] = [];
let stopReason = `reached MAX_ITERATIONS (${MAX_ITERATIONS})`;
let childrenDone = false;
let epicVerdict: "approve" | "changes" | "skipped" = "skipped";
let epicNotes = "";

function formatRunLog(): string {
  const iterations =
    runLog.length === 0
      ? "_No iteration ran any issue._"
      : runLog
          .map(({ iteration, issues, merged }) =>
            [
              `- Iteration ${iteration} (${merged ? "merged" : "not merged"}):`,
              ...issues.map((i) => {
                const detail =
                  i.outcome === "failed"
                    ? ` — ${i.error}`
                    : ` — ${i.ahead} commit(s) ahead, reviews: ${i.reviews.join(", ") || "none"}`;
                return `  - ${i.id} (${i.branch}) [${i.outcome}] ${i.title}${detail}`;
              }),
            ].join("\n"),
          )
          .join("\n");
  return [
    `Stop reason: ${stopReason}`,
    `All children done: ${childrenDone}`,
    `Epic review: ${epicVerdict}${epicNotes ? ` — ${epicNotes}` : ""}`,
    "",
    iterations,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Phase 0: select root + bootstrap integration branch and draft PR (host)
// ---------------------------------------------------------------------------

acquireLock();
const rootArg = process.argv[2] ?? "";
console.log(`\n=== select-root ${rootArg || "(discover)"} ===\n`);

const rootRun = await sandcastle.run({
  sandbox: docker(),
  agent,
  name: "select-root",
  promptFile: promptFile("select-root"),
  promptArgs: { ROOT_ARG: rootArg },
  output: sandcastle.Output.object({
    tag: "root",
    schema: rootSchema,
    maxRetries: 1,
  }),
});
if (rootRun.output === null) {
  console.log("Nothing workable in the tracker. Exiting.");
  process.exit(0);
}
const root = rootRun.output;
const integration = root.branch;
console.log(`Root ${root.id}: ${root.title} → ${integration}`);

git("fetch", "origin", "--prune");
const localExists = gitOk("show-ref", "--verify", "--quiet", `refs/heads/${integration}`);
const remoteExists = gitOk("show-ref", "--verify", "--quiet", `refs/remotes/origin/${integration}`);
if (!localExists && remoteExists) {
  git("branch", "--track", integration, `origin/${integration}`);
} else if (!localExists) {
  // Empty seed commit without checkout: gh refuses a PR with zero commits over main.
  const sha = git(
    "commit-tree", "origin/main^{tree}", "-p", "origin/main",
    "-m", `chore(${root.id.toLowerCase()}): open integration branch ${integration}`,
  );
  git("update-ref", `refs/heads/${integration}`, sha);
} else if (remoteExists && gitOk("merge-base", "--is-ancestor", integration, `origin/${integration}`)) {
  // Refused when checked out in a stale worktree; createSandbox fast-forwards that case.
  gitOk("branch", "-f", integration, `origin/${integration}`);
}

const integ = await sandcastle.createSandbox({
  branch: integration,
  baseBranch: "origin/main",
  sandbox: docker(),
  hooks,
  copyToWorktree,
});
const pushIntegration = () => git("push", "-u", "origin", integration);
pushIntegration();

if (!ok("gh", ["pr", "view", integration, "--json", "number"])) {
  run(
    "gh",
    ["pr", "create", "--draft", "--base", "main", "--head", integration,
      "--title", root.prTitle, "--body-file", "-"],
    root.prBody,
  );
}
const prUrl = run("gh", ["pr", "view", integration, "--json", "url", "--jq", ".url"]);
console.log(`PR: ${prUrl}`);

// ---------------------------------------------------------------------------
// Per-issue pipeline: implement → (review → fix)* on its own branch/sandbox
// ---------------------------------------------------------------------------

async function runIssue(issue: {
  id: string;
  title: string;
  branch: string;
}): Promise<{ reviews: string[] }> {
  const sandbox = await sandcastle.createSandbox({
    branch: issue.branch,
    baseBranch: integration,
    sandbox: docker(),
    hooks,
    copyToWorktree,
  });
  const reviews: string[] = [];
  try {
    await sandbox.run({
      name: "implementer",
      agent,
      maxIterations: IMPLEMENT_ITERATIONS,
      promptFile: promptFile("implement"),
      promptArgs: {
        TASK_ID: issue.id,
        ISSUE_TITLE: issue.title,
        BRANCH: issue.branch,
        INTEGRATION_BRANCH: integration,
        ROOT_ID: root.id,
      },
    });
    if (commitsAhead(integration, issue.branch) === 0) return { reviews };

    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      const result = await sandbox.run({
        name: "reviewer",
        agent,
        promptFile: promptFile("review"),
        promptArgs: {
          TASK_ID: issue.id,
          BRANCH: issue.branch,
          TARGET_BRANCH: integration,
        },
      });
      const review = parseTag(result.stdout, "review", reviewSchema);
      reviews.push(review.verdict);
      if (review.verdict === "approve") break;
      await sandbox.run({
        name: "fixer",
        agent,
        maxIterations: FIX_ITERATIONS,
        promptFile: promptFile("fix-review"),
        promptArgs: {
          TASK_ID: issue.id,
          BRANCH: issue.branch,
          NOTES: review.notes,
        },
      });
    }
    return { reviews };
  } finally {
    await sandbox.close();
  }
}

// ---------------------------------------------------------------------------
// Main loop: plan → issues → merge
// ---------------------------------------------------------------------------

try {
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

    const planRun = await integ.run({
      name: "planner",
      agent,
      promptFile: promptFile("plan"),
      promptArgs: { ROOT_ID: root.id, INTEGRATION_BRANCH: integration },
    });
    const plan = parseTag(planRun.stdout, "plan", planSchema);
    if (plan.notes) console.log(`Planner: ${plan.notes}`);

    if (plan.done || plan.issues.length === 0) {
      childrenDone = plan.done;
      stopReason = plan.done ? "all children done" : "no workable issue";
      break;
    }
    for (const issue of plan.issues) {
      console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
    }

    const settled = await Promise.allSettled(plan.issues.map(runIssue));

    const record: IterationRecord = {
      iteration,
      merged: false,
      issues: settled.map((outcome, i) => {
        const issue = plan.issues[i]!;
        const ahead = commitsAhead(integration, issue.branch);
        const base = { ...issue, ahead, reviews: [] as string[] };
        if (outcome.status === "rejected") {
          console.error(`  ✗ ${issue.id} failed: ${outcome.reason}`);
          return { ...base, outcome: "failed", error: String(outcome.reason) };
        }
        return {
          ...base,
          reviews: outcome.value.reviews,
          outcome: ahead > 0 ? "progress" : "no-progress",
        };
      }),
    };
    runLog.push(record);

    if (settled.every((s) => s.status === "rejected")) {
      stopReason = "every pipeline failed (credits exhausted?)";
      break;
    }

    // Progress = commits on the branch not yet in integration, whatever run produced them.
    const mergeable = record.issues.filter((i) => i.ahead > 0);
    if (mergeable.length === 0) {
      stopReason = "no branch progressed this iteration";
      break;
    }

    await integ.run({
      name: "merger",
      agent,
      promptFile: promptFile("merge"),
      promptArgs: {
        ROOT_ID: root.id,
        INTEGRATION_BRANCH: integration,
        BRANCHES: list(mergeable.map((i) => i.branch)),
        ISSUES: list(mergeable.map((i) => `${i.id}: ${i.title}`)),
      },
    });
    pushIntegration();
    record.merged = true;
  }

  // -------------------------------------------------------------------------
  // Epic review: only once every child landed; fixes go straight on integration.
  // -------------------------------------------------------------------------
  if (childrenDone) {
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      console.log(`\n=== Epic review ${round}/${MAX_REVIEW_ROUNDS} ===\n`);
      const result = await integ.run({
        name: "epic-reviewer",
        agent,
        promptFile: promptFile("epic-review"),
        promptArgs: { ROOT_ID: root.id, INTEGRATION_BRANCH: integration },
      });
      const review = parseTag(result.stdout, "review", reviewSchema);
      epicVerdict = review.verdict;
      epicNotes = review.notes;
      if (review.verdict === "approve") break;
      await integ.run({
        name: "epic-fixer",
        agent,
        maxIterations: FIX_ITERATIONS,
        promptFile: promptFile("fix-review"),
        promptArgs: {
          TASK_ID: root.id,
          BRANCH: integration,
          NOTES: review.notes,
        },
      });
      pushIntegration();
    }
  }
} catch (error) {
  stopReason = `aborted: ${error}`;
  console.error(`\nRun aborted: ${error}`);
}

// ---------------------------------------------------------------------------
// Summary → PR body, Linear comment on the root, log file
// ---------------------------------------------------------------------------

const rawRunLog = formatRunLog();
let summaryText: string | undefined;
try {
  const result = await integ.run({
    name: "summarizer",
    agent,
    promptFile: promptFile("summary"),
    promptArgs: {
      ROOT_ID: root.id,
      INTEGRATION_BRANCH: integration,
      PR_URL: prUrl,
      EPIC_VERDICT: epicVerdict,
      RUN_LOG: rawRunLog,
    },
  });
  summaryText = lastTag(result.stdout, "summary");
} catch (error) {
  console.error(`\nSummarizer failed: ${error}`);
} finally {
  await integ.close();
}

const summaryPath = `${DIR}/logs/summary-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
mkdirSync(`${DIR}/logs`, { recursive: true });
writeFileSync(
  summaryPath,
  summaryText ?? `# Run log (summarizer failed)\n\n${rawRunLog}`,
);

if (summaryText) {
  run("gh", ["pr", "edit", integration, "--body-file", "-"], summaryText);
  if (epicVerdict === "approve") ok("gh", ["pr", "ready", integration]);
}

console.log(`\n=== Run summary ===\n\n${summaryText ?? rawRunLog}\n\nSaved to ${summaryPath}`);
console.log(`PR (${epicVerdict === "approve" ? "ready for review" : "draft"}): ${prUrl}`);
