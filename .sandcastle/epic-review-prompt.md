# TASK

Review the whole delivery of {{ROOT_ID}} on `{{INTEGRATION_BRANCH}}` (the current branch) against `origin/main` and return a verdict. Read-only: a fixer applies your notes on this branch.

# CONTEXT

## Root and children

!`linear api 'query{issue(id:"{{ROOT_ID}}"){identifier title description children{nodes{identifier title description state{name}}}}}' | jq '.data.issue'`

## Commits

!`git log --oneline origin/main..{{INTEGRATION_BRANCH}}`

## Files changed

!`git diff --stat origin/main...{{INTEGRATION_BRANCH}}`

Read the full diff yourself: `git diff origin/main...{{INTEGRATION_BRANCH}}`, per file when large.

# REVIEW

Run `npm test`. Then check, in order:

1. **Root** — every acceptance criterion of the root holds end to end, not only each child in isolation. The children combine coherently: one helper per concept, consistent naming, no leftover from a superseded child.
2. **Correctness** — edge cases, unsafe casts or `any`, injection, credential leaks, behaviour without a test.
3. **README** — the `## What this fork adds` section reflects every user-facing change, and nothing else in that file moved.

`changes` is for what a fixer can land in place on this branch. Missing scope that would need a new ticket goes in the notes as a remark, never as a `changes` item, and no ticket is created here.

# OUTPUT

<review>
{"verdict":"approve","notes":"…"}
</review>

`verdict` is `approve` or `changes`. For `changes`, `notes` is a numbered list — file, what is wrong, what to do. For `approve`, one line plus any remarks for the human.

Then output <promise>COMPLETE</promise>.
