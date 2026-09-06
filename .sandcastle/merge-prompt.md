# TASK

Merge these branches into `{{INTEGRATION_BRANCH}}` (the current branch), then close their issues.

{{BRANCHES}}

Issues:

{{ISSUES}}

# MERGE

For each branch: `git merge <branch> --no-edit`. Resolve conflicts by reading both sides and keeping the behaviour each issue asks for. After each merge, `npm test`; fix failures before the next branch. A branch that cannot be made green: `git merge --abort`, leave it out, and explain in a comment on its issue — it stays open.

The push is done by the orchestrator.

# CLOSE

For each merged branch: `linear issue update <ID> --state Done`, then `linear issue comment add <ID> --body "<one-line merge summary>"`.

{{ROOT_ID}} is never updated here: GitHub drives its state through the pull request.

Output <promise>COMPLETE</promise>.
