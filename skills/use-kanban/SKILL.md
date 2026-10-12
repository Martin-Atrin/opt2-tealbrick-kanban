---
name: use-kanban
description: How {{agent.name}} logs work on the Work Ethic Kanban board in {{workspace.name}}: when to use the board, how to decompose, comment, block and complete.
---
# Logging work on the board ({{agent.name}})

The Kanban board is the record of who does what in {{workspace.name}}. The owner reads it to see what you did,
what is stuck and what is done. Everything you write appears under your own name. "Projects" here are board
projects, not folders on disk.

- **{{scope.project.own}}** is your own project. You can read, work in and delete there. New issues and goals go
  there when you name no project.
- Shared projects come from the owner. You can usually read and work in them. Call `kanban__projects_list` to see
  what you can reach.

## When to use the board

Use the board when any of these is true:

- the work has more than one step, or will take longer than one session;
- another agent or the owner will continue it, review it, or decide something in it;
- parts can run in parallel or wait for each other;
- the owner will want to see later what was done and why.

For a quick question or a one-step answer, answer directly and do not create an issue.
Do not keep a second task list in chat or in local files. The board is the one list.

## Start of a session

1. Call `kanban__work_next`. `ready` lists issues assigned to you whose dependencies are all done. `inProgress`
   lists issues you already started.
2. Before you work on an issue, call `kanban__issue_get`. Read the summary, the comments and the dependencies.
   The issue may have changed since it was assigned. If it is blocked, done or deleted, do not work on it.
3. Move it to `in_progress` with `kanban__issue_update` when you start.

## Columns

`backlog` (not planned yet), `todo` (planned), `in_progress`, `in_review`, `blocked`, `done`. An issue is
**ready** when it is in `todo` and every issue it depends on is `done`. Ready is computed; you never set it.

## While you work

- Add a comment with `kanban__issue_comment_add` for things the next worker needs: a finding, a decision and its
  reason, a partial result, a question. Do not paste your reasoning or the whole conversation.
- If the work needs a review, move it to `in_review` and say in a comment what to check.
- Link a Knowledge document with `kanban__issue_document_link` instead of copying its text: read it first with
  your own Knowledge access, then pass its `document` id and `title`. The board keeps only the id and title.

## Blocked

Block only when you need a decision or an input you cannot get yourself. Call `kanban__issue_block` with a reason
that names the decision in one or two sentences ("Which API key should the importer use: staging or production?").
"Stuck" is not a reason. Put long context in a comment first.

## Done

Call `kanban__issue_complete` with a short `result`: what shipped and where it is (file, document, link). Issues that
depend on it become ready when all their dependencies are done; the answer lists them in `promoted`.
Never complete work you did not finish. Block it, or comment what is left and leave it in progress.

## Splitting work (when you coordinate)

When you plan work for several agents:

1. Say the plan back first: the pieces, who does each, and what waits for what. Let the owner correct it.
2. Create one issue per piece with `kanban__issue_create`. Set `assignee` to the agent id from the directory, `"me"`
   or `"owner"`. Use `dependsOn` (issue ids in the same project) for pieces that must wait. A dependency must be
   created before the issue that waits for it.
3. Do not do the pieces yourself when you coordinate. Your job is to split, assign, follow up and summarise.
4. Do not create the whole plan up front when later steps depend on what the first steps find. Create the next
   issues when the earlier ones are done.
5. When a reviewer sends work back, create a new issue that depends on the reviewed one. Do not reopen old work
   silently.

## Rules

- Send an idempotency key with every `create` call (`issue_create`, `goal_create`, `issue_comment_add`). Repeating
  a call with the same key returns the first result instead of a duplicate.
- When an issue is one more run of repeated work (a weekly report, a recurring check), set `template` on
  `issue_create` to a short stable lowercase key such as `weekly-report` (uppercase is refused). The owner and Evolution use it to see repeated work.
- Deleting is held for the owner's approval. If a call answers `held`, poll `kanban__tb_hold_status` with the
  `holdId`, then repeat the same call with the same input and key.
- If a call answers `not_found`, you cannot see that item. Do not guess ids. List first.
