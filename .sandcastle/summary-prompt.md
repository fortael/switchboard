# TASK

The run for {{ROOT_ID}} is over. Write the body of the pull request {{PR_URL}} — it doubles as the report for the human who picks the work up next.

Epic review verdict: `{{EPIC_VERDICT}}` — `approve` means the PR is marked ready for review; anything else keeps it draft.

# RUN LOG

Per-iteration outcome recorded by the orchestrator:

{{RUN_LOG}}

# CONTEXT

## Root and children

!`linear api 'query{issue(id:"{{ROOT_ID}}"){identifier title description url children{nodes{identifier title state{name}}}}}' | jq '.data.issue'`

## Commits on `{{INTEGRATION_BRANCH}}`

!`git log --oneline origin/main..{{INTEGRATION_BRANCH}}`

## Files changed

!`git diff --stat origin/main...{{INTEGRATION_BRANCH}}`

# REPORT

Read-only on the repo. For a failed or partial issue, read its latest comments with `linear issue comment list <ID> --json`. Write in the language of the root issue, under 80 lines, with exactly these sections:

1. **Summary** — what this PR delivers, three lines max, with the Linear URL of the root.
2. **Changes** — one line per child issue: id, title, status (merged / partial / not started), commits (short SHA + subject).
3. **How to test** — the manual checks a human runs, derived from the acceptance criteria: action → expected result.
4. **Not done** — failed, partial or unmerged issues with the likely cause and whether an agent can retry or a human is needed. Epic review remarks go here too.
5. **Next steps** — an ordered checklist.

Post the same text on the root: write it to `/tmp/summary.md`, then `linear issue comment add {{ROOT_ID}} --body-file /tmp/summary.md`.

Output the report inside `<summary>` tags, then output <promise>COMPLETE</promise>.
