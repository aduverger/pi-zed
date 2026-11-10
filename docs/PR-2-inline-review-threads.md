# PR 2: Two-way review threads in Zed editors and diffs

Status: planned, not implemented. Depends on PR 1's proven live attachment.

## Outcome
Post a comment on selected file/diff lines, automatically send it to the selected live pi
session, and render the agent's reply beneath the same code range.

## Repository and source of truth
Implement as a Zed source contribution/fork, not a marketplace extension. Before coding,
pin the target Zed commit and inspect its editor review overlays, multibuffer/diff mapping,
Agent Panel dispatch, ACP update handling and workspace persistence end to end.
Reuse these paths rather than add a separate review panel.
The Zed checkout is not present in this repository.

## Implementation plan
1. Extend the existing review overlay into a thread with stable thread/message IDs,
   user/agent authorship, submission state and replies.
2. Add an action for regular editor selections and reuse diff gutter selection.
   Split multi-file selections into distinct anchored threads, or visibly reject them.
3. Keep anchoring in Zed's editor/domain layer:
   - buffer anchors while open;
   - repository/worktree identity, path, base revision, old/new diff side and captured
     excerpt/context for persistence;
   - correct mapping for staged/unstaged views, deleted lines and renamed files.
   Resolve only unique matches after reopening; never silently jump to a similar line.
4. Persist threads and replies through Zed's workspace persistence. Do not put annotations
   into source files. Keep original excerpts when code changes.
5. Posting sends immediately to the selected live session. Carry thread and submission IDs
   through an explicit, versioned ACP extension shared with PR 1's bridge. Do not infer
   reply ownership from prose or from whichever editor is focused.
6. Route replies into the originating thread. Keep terminal/unrelated messages in the main
   agent transcript. Preserve submission ownership across busy queues and disconnects.
   Retry only after reconciling whether the original submission was accepted.
7. Expose outdated status when the anchor cannot be safely recovered. Preserve the thread,
   original context and replies; allow explicit user reattachment.
8. Test regular files, both diff sides, deletion-only hunks, staged/unstaged differences,
   edits before/inside ranges, revert, rename, reopen, ambiguous anchors, busy agents,
   disconnect/retry and multiple threads. Run affected Zed checks and manual GUI acceptance.

## Acceptance
Post from an unchanged file and from added/deleted diff lines. In every case the existing
terminal pi sees the exact excerpt and location, and the reply appears in the correct thread.
Restart Zed and recover threads. Change/delete the target and verify safe reanchoring or an
explicit outdated state, without losing original source information.

## Non-goals
GitHub/GitLab publication, collaboration/accounts, generic UI extension APIs, Rex embedding,
or a replacement review panel.

## Decisions to confirm before PR 2 implementation
- Target Zed version and upstream contribution versus maintained fork.
- Thread retention scope (workspace-local proposed), deletion/resolution UX, and handling
  multiple-file selections (split versus reject).
- Whether one agent response may address several threads or each submission is serialized.
- How to expose cancellation of the shared agent when terminal work may also be affected.

## Decision ledger
Provisional, least-confident first:
1. Workspace-local persistence is proposed; sharing/export was not requested.
2. Explicit structured correlation is required before routing replies inline; PR 1 deliberately
   does not introduce speculative comment storage or a review-specific wire format.
3. Ambiguous anchors remain outdated rather than guessed; original excerpts survive all edits.
4. Extend the existing review overlay, not an independent panel.
