# TASK

Pick the **root** issue this run delivers as one pull request, and describe it for the orchestrator.

Requested root: `{{ROOT_ARG}}` (empty = choose one yourself).

# CONTEXT

## Requested root, with its children

<root-json>

!`if [ -n "{{ROOT_ARG}}" ]; then linear api 'query{issue(id:"{{ROOT_ARG}}"){identifier title description branchName state{name} labels{nodes{name}} children{nodes{identifier title state{name type}}}}}' | jq '.data.issue'; else echo null; fi`

</root-json>

## Open roots of project Wooton (issues without a parent)

<candidates-json>

!`linear api 'query{issues(first:250,filter:{project:{name:{eq:"Wooton"}},parent:{null:true},state:{type:{nin:["completed","canceled","duplicate"]}}}){nodes{identifier title branchName state{name} createdAt labels{nodes{name}} children{nodes{identifier state{type} labels{nodes{name}}}}}}}' | jq '[.data.issues.nodes[] | {id:.identifier,title,branch:.branchName,state:.state.name,createdAt,labels:[.labels.nodes[].name],children:[.children.nodes[]|{id:.identifier,done:(.state.type|IN("completed","canceled","duplicate")),labels:[.labels.nodes[].name]}]}]'`

</candidates-json>

# SELECTION

A root is the unit of one pull request: an epic whose children are the work, or a standalone issue that is its own work.

- Requested root given → take it as is, whatever its labels or state.
- Otherwise pick from the candidates, in this order: a root already `In Progress` with agent-workable children left; then a root labelled `ready-for-agent` (or whose open children all are); then the oldest. A root with every child done and nothing left is not a candidate.
- Nothing workable → output `<root>null</root>`.

# OUTPUT

`branch` is the root's `branchName` from Linear, verbatim. `prTitle` is a conventional-commit style title ending with the root id, e.g. `feat(session): descriptive Session title (VIN-XXX)`. `prBody` is three lines: the Linear URL, the goal in one sentence, and `Draft — built by sandcastle, body rewritten at the end of the run.` Write both in the language of the root issue.

<root>
{"id":"VIN-XXX","title":"…","branch":"feature/VIN-XXX","prTitle":"…","prBody":"…"}
</root>

Always emit the `<root>` tag.
