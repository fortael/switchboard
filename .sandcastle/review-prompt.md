# TASK

Review branch `{{BRANCH}}` for {{TASK_ID}} against `{{TARGET_BRANCH}}` and return a verdict. Read-only: a fixer applies your notes.

# CONTEXT

## Issue

!`linear issue view {{TASK_ID}} --json --no-pager | jq '{identifier,title,description}'`

## Diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW

Run `npm test`. Then check, in order:

1. **Spec** — every acceptance criterion of the issue is met; nothing outside the issue's scope changed.
2. **Correctness** — edge cases, unsafe casts or `any`, injection, credential leaks, behaviour without a test.
3. **Clarity** — needless complexity or nesting, duplication, naming, nested ternaries, comments that paraphrase the code. Standards: @.sandcastle/CODING_STANDARDS.md.

`changes` is for what must land before merge. A nit that hurts nothing goes in the notes of an `approve`.

# OUTPUT

<review>
{"verdict":"approve","notes":"…"}
</review>

`verdict` is `approve` or `changes`. For `changes`, `notes` is a numbered list — file, what is wrong, what to do — the fixer works from it alone. For `approve`, one line.

Then output <promise>COMPLETE</promise>.
