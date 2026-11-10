# PR 2: Two-way review threads in Zed editors and diffs

Status: regular-file vertical slice implemented locally; manual end-to-end UI acceptance pending.
Diff-side anchoring and persistence are not implemented. PR 1 attachment and the unmodified
custom macOS build/SSH connection were confirmed by the user.

## Outcome
Post a comment on selected file/diff lines, automatically send it to the selected live pi
session, and render the agent's reply beneath the same code range.

## Repository and source of truth
Implement as a Zed source contribution/fork, not a marketplace extension. Before coding,
pin the target Zed commit and inspect its editor review overlays, multibuffer/diff mapping,
Agent Panel dispatch, ACP update handling and workspace persistence end to end.
Reuse these paths rather than add a separate review panel.
Zed is a separate sibling checkout at `/Users/alex/code/aduverger/zed-pi-review`, branch
`feat/pi-inline-review`, based on stable `v1.27.0` / `c84af5b99cbc366d675064e52b23664a015b6e35`.
The bridge changes live in this repository on `feat/regular-file-review`.

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

## Remaining decisions for full PR 2
- Upstream contribution versus maintained fork (the stable release/custom build is approved).
- Thread retention scope (workspace-local proposed), deletion/resolution UX, and handling
  multiple-file selections (split versus reject).
- Whether one agent response may address several threads or each submission is serialized.
- How to expose cancellation of the shared agent when terminal work may also be affected.

## First vertical slice

In the custom Zed build:

1. Attach the Agent Panel to `pi-live` (the configured agent key must be exactly `pi-live`).
2. Open a regular saved file, select one contiguous range, then use the command palette:
   **agent: comment with pi live**.
3. Type the comment in the inline overlay and press Enter. Posting sends immediately.
4. The final reply appears below that comment; streaming remains in the Agent Panel.

The source path is absolute on the file's host, including SSH files. The request includes
full selected lines, one-based line numbers, and the current editor snapshot (which may
contain unsaved edits). A selection ending at column zero excludes that next line.
Diff/multibuffer editors and multiple selections are rejected. A caret reviews its line.
If an open overlay starts on the same line but covers another range, close it before opening
the new range. Reopen the action on the original range to recover a dismissed overlay while
the editor remains open.

The existing editor review overlay stores the comment and renders the final reply. The
agent integration captures the active pi-live thread when the overlay opens and uses
`AcpThread::send`, not a parallel transport. Each posted comment receives fresh UUID thread
and submission IDs. The text content block carries `_meta["zed-pi-live/review"]`:

```json
{"version": 1, "threadId": "uuid", "submissionId": "uuid"}
```

A successful `end_turn` prompt response returns those IDs plus `text` under the same key.
Missing/mismatched metadata, cancellation, disconnection, or provider failure produces an
inline error; there is no automatic retry. The extension captures completed assistant text
and responds only after `agent_settled`. User/custom-message interleaving during the review
causes an attribution error rather than putting an unrelated answer under the code.

Buffer anchors preserve the selection across edits before it. Changed selected text renders
an **Outdated** warning with the original excerpt and retains the reply. This is an in-memory
prototype: closing the editor or restarting Zed loses comments. There is no persistent
thread store, follow-up conversation grouping, retry reconciliation, diff-side support,
rename/reopen reanchoring, or reattachment UI yet. **This does not complete PR 2.**

### Validation

- `pnpm check`, `pnpm test` (21 tests), `pnpm build`: passed on macOS.
- `cargo build --locked`: passed after final changes on Xcode 27.2 / Rust 1.98.1.
- `cargo test --locked -p editor review --lib`: passed (26 tests, including 2 new tests).
- `cargo test --locked -p agent_ui inline_review --lib`: passed (1 test).
- GPUI coverage verifies posting the exact full-line excerpt/path, exclusion of the trailing
  line, retention through edits before selection, outdated detection inside selection, and
  refusal of unsaved buffers. Protocol tests verify exact IDs, sequential submissions,
  busy terminal work versus interleaving, cancellation, provider failure and malformed input.
- The debug linker warns that `__eh_frame` exceeds 16 MiB; build and tests still succeed.
- Remaining manual check: new action visibility, Enter submission, long/multiline reply
  layout, SSH file path/excerpt in the actual terminal pi, two different selected ranges,
  changed-code warning, and failure display. Full repository tests/clippy and a new real
  provider smoke test have not been run.

### Slice decision ledger (least-confident first)

1. Require the existing configured key `pi-live` for this prototype rather than adding a
   new capability-negotiation layer. Question: should renamed bridge registrations be supported?
2. Capture the selected agent when the overlay opens, even if the Agent Panel changes before
   posting. Question: should the overlay instead require choosing the target on each post?
3. Each post is a separate correlated request, not yet a persistent conversation thread.
   Replies render as final plain text with a bounded scroll area; no inline streaming yet.
4. Conservative outdated detection compares anchored text with the posted excerpt. Reverting
   exactly to that excerpt clears the warning; rename/reopen handling remains a later slice.
5. Reuse native per-start-line overlay grouping, but reject changing an open range on that
   line rather than silently submitting different code. Grouping by persistent ranges is later.
6. Reject multibuffer/diff selections until old/new-side mapping is implemented; do not guess.
7. An already-busy bridge rejects a second concurrent review; errors retain the comment.
   Cancellation stays in the existing Agent Panel and may abort shared terminal work.
8. Keep existing lifecycle/disconnect behavior and surface uncertain outcomes without retry.
9. Packaging remains a pi extension plus a Zed ACP integration; editor UI requires the Zed
   source change. No marketplace publication or GitHub fork publication is included here.

## Original decision ledger
Provisional, least-confident first:
1. Workspace-local persistence is proposed; sharing/export was not requested.
2. Explicit structured correlation is required before routing replies inline; PR 1 deliberately
   does not introduce speculative comment storage or a review-specific wire format.
3. Ambiguous anchors remain outdated rather than guessed; original excerpts survive all edits.
4. Extend the existing review overlay, not an independent panel.
