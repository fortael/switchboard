# TASK

The orchestration run is over. Write a concise end-of-run report for the human who will pick up the work next.

# RUN LOG

Per-iteration outcome recorded by the orchestrator:

{{RUN_LOG}}

# CONTEXT

## Commits landed on the current branch during this run

!`git log --oneline {{START_SHA}}..HEAD`

## Issues still open for agents

!`linear api 'query{issues(first:100,filter:{project:{name:{eq:"Wooton"}},labels:{name:{eq:"ready-for-agent"}},state:{type:{nin:["completed","canceled","duplicate"]}}}){nodes{identifier title state{name} inverseRelations{nodes{type issue{identifier state{type}}}}}}}' | jq -r '.data.issues.nodes[] | "- \(.identifier): \(.title) [\(.state.name)] blockedBy=\([.inverseRelations.nodes[]|select(.type=="blocks" and ((.issue.state.type|IN("completed","canceled","duplicate"))|not))|.issue.identifier]|join(","))"'`

## Issues waiting on a human

!`linear api 'query{issues(first:100,filter:{project:{name:{eq:"Wooton"}},labels:{name:{in:["needs-info","ready-for-human","needs-triage"]}},state:{type:{nin:["completed","canceled","duplicate"]}}}){nodes{identifier title labels{nodes{name}}}}}' | jq -r '.data.issues.nodes[] | "- \(.identifier): \(.title) [\([.labels.nodes[].name]|join(","))]"'`

# REPORT

Do not modify any file or issue. Read-only. If a failed or no-commit issue needs more context, check its latest comments with `linear issue view <ID> --json --no-pager`.

Output the report in markdown inside `<summary>` tags, with exactly these sections:

1. **What happened** — per iteration: issues planned, committed, failed, or left without commits, and whether the iteration was merged. Mention the stop reason. One line each, no fluff.
2. **Merged** — each committed issue whose iteration was merged, with its commits (short SHA + subject).
3. **Not done** — each failed / no-commit / unmerged issue with the likely cause (from the run log and issue comments) and whether it is retryable by an agent or needs a human.
4. **Next steps** — an ordered checklist: issues to retry, issues to unblock, issues needing human input, anything to verify manually (tests, deployment, launchd, etc.).

Keep it under 60 lines. Then output <promise>COMPLETE</promise>.
