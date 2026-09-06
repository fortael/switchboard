# TASK

Decide which children of {{ROOT_ID}} the orchestrator works next, in parallel, on top of `{{INTEGRATION_BRANCH}}` (the current branch).

# CONTEXT

## Root and children

<root-json>

!`linear api 'query{issue(id:"{{ROOT_ID}}"){identifier title description state{name} children{nodes{identifier title description state{name type} labels{nodes{name}} inverseRelations{nodes{type issue{identifier state{type}}}}}}}}' | jq '.data.issue | {id:.identifier,title,body:(.description//""),state:.state.name,children:[.children.nodes[]|{id:.identifier,title,body:(.description//""),state:.state.name,done:(.state.type|IN("completed","canceled","duplicate")),labels:[.labels.nodes[].name],blockedBy:[.inverseRelations.nodes[]|select(.type=="blocks" and ((.issue.state.type|IN("completed","canceled","duplicate"))|not))|.issue.identifier]}]}'`

</root-json>

## Landed on `{{INTEGRATION_BRANCH}}`

!`git log --oneline origin/main..{{INTEGRATION_BRANCH}}`

## Issue branches and their unmerged commits

!`for b in $(git for-each-ref --format='%(refname:short)' 'refs/heads/sandcastle/issue-*'); do echo "$b: $(git rev-list --count {{INTEGRATION_BRANCH}}..$b) unmerged commit(s)"; done`

# PLAN

Scope is the children listed above (a root without children is worked as a single issue, id = root). Branch name is always `sandcastle/issue-<ID>` so a resumed issue lands on its previous branch.

Include a child when it is not done and none of its `blockedBy` is still open. Then split the remainder so branches merge cleanly: two children touching the same modules run serially — keep the one the other depends on. `blockedBy` from the tracker is always honoured; the file-overlap rule is your judgement.

Resume: an issue whose branch carries unmerged commits is picked up where it stopped — include it, the implementer inspects the branch. An issue whose branch has no unmerged commits but whose work is already in the landed log (a merge that closed no ticket) is closed here — `linear issue update <ID> --state Done` plus a one-line comment — and left out. That is the only write this step makes.

`done` is true when every child is done and nothing is left to plan; `issues` is then empty. An empty `issues` with `done: false` means everything left is blocked or needs a human — say why in `notes`.

# OUTPUT

<plan>
{"issues":[{"id":"VIN-145","title":"…","branch":"sandcastle/issue-VIN-145"}],"done":false,"notes":"one line"}
</plan>

Always emit the `<plan>` tag.
