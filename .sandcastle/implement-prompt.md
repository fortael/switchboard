# TASK

Deliver {{TASK_ID}} — {{ISSUE_TITLE}} — on branch `{{BRANCH}}` (checked out). It is a child of {{ROOT_ID}} and will be merged into `{{INTEGRATION_BRANCH}}`.

Only this issue. Siblings and the parent are context, not scope.

# CONTEXT

## Issue

!`linear issue view {{TASK_ID}} --json --no-pager`

## Comments (earlier runs report here)

!`linear issue comment list {{TASK_ID}} --json 2>/dev/null || true`

## Parent

!`linear issue view {{ROOT_ID}} --json --no-pager | jq '{identifier,title,description}'`

## Branch state

Commits here, not yet in `{{INTEGRATION_BRANCH}}`:

!`git log --oneline {{INTEGRATION_BRANCH}}..HEAD`

Commits in `{{INTEGRATION_BRANCH}}` missing here: !`git rev-list --count HEAD..{{INTEGRATION_BRANCH}}`

Working tree:

!`git status --short`

# RESUME

The branch may carry work from an earlier run. Before writing code:

1. Read the commits and comments above against the acceptance criteria. Keep what holds and continue from there.
2. If `{{INTEGRATION_BRANCH}}` has commits missing here: `git merge {{INTEGRATION_BRANCH}} --no-edit`, resolve conflicts, `npm test`.
3. Uncommitted changes are a crashed run: review them, then commit or discard.

# EXECUTION

Explore first: read the modules and tests the issue touches until you can name every file you will change.

Test-first where it applies — RED (one failing test), GREEN, repeat, then refactor. `npm test` before every commit. Commit small and often, conventional format with the issue id: `type(scope): subject (VIN-XXX)`.

A user-facing feature also updates the `## What this fork adds` section of `README.md`, in the same run — only that section.

# COMPLETION

Complete when every acceptance criterion holds, `npm test` is green and the tree is clean. Then `linear issue comment add {{TASK_ID}} --body "<what landed, key decisions, what the reviewer should look at>"` and output <promise>COMPLETE</promise>.

Blocked or out of budget: commit what holds, comment the remaining work and the blocker, and output <promise>COMPLETE</promise> as well. The issue state is set by the merger, never here.
