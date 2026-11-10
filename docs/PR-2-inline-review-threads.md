# PR 2: Two-way review threads in Zed editors and diffs

Status: regular-file vertical slice manually confirmed by the user. Separate authored replies,
Markdown, stable discussions, and queued posting are implemented locally; manual acceptance
of these refinements is pending.
Remote user-level persistence is implemented locally; GUI restart acceptance is pending.
Diff-side anchoring remains unimplemented. PR 1 attachment and the unmodified custom
macOS build/SSH connection were confirmed by the user.

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
4. Persist posted discussions on the adapter host in remote user-level storage (the user's
   accepted choice supersedes the original local-workspace-DB proposal). Do not put files in
   the project. Keep original excerpts when code changes.
5. Posting automatically queues for the selected live session. Carry discussion and submission IDs
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
- Deletion/resolution UX and handling multiple-file selections (split versus reject).
  Storage scope is decided: remote OS user, partitioned by canonical project path.
- Queue coordination across multiple independently attached Zed threads/processes (currently
  one FIFO per attached Agent Panel thread; the bridge still permits one pending request).
- How to expose cancellation of the shared agent when terminal work may also be affected.

## First vertical slice

In the custom Zed build:

1. Attach the Agent Panel to `pi-live` (the configured agent key must be exactly `pi-live`).
2. Open a regular saved file, select one contiguous range, then use the command palette:
   **agent: comment with pi live**.
3. Type the comment in the inline overlay and press Enter. Posting queues automatically.
4. Your comment keeps your avatar; the final reply gets a separate **Pi** row with an agent
   icon and Markdown formatting. Streaming remains in the Agent Panel.
5. Post more comments while waiting: they show **Queued**, then **Running**, then **Answered**
   or an error. Each queued comment has its own cancellation button; cancelling it does not
   interrupt the running pi request.

The source path is absolute on the file's host, including SSH files. The request includes
full selected lines, one-based line numbers, and the current editor snapshot (which may
contain unsaved edits). A selection ending at column zero excludes that next line.
Diff/multibuffer editors and multiple selections are rejected. A caret reviews its line.
If an overlay already starts on the same line but covers another range, reopen that discussion
or choose a different starting line; native grouping is still per start line. Reopen the action
on the original range to recover a dismissed overlay while the editor remains open.
The X now hides only its own discussion behind a **Show discussion** marker. The marker
reopens the existing comments, replies, and input draft; hiding does not cancel queued work.

The existing editor review overlay stores the comment and renders the final reply. The
agent integration captures the active pi-live thread when the overlay opens and uses
`AcpThread::send`, not a parallel transport. Each posted comment receives a fresh submission
UUID. Posts on the same anchored range reuse a discussion UUID, including after dismissing
and reopening the overlay while the editor remains open. The existing wire field `threadId`
now holds that stable discussion ID; no protocol version change is necessary. The text
content block carries `_meta["zed-pi-live/review"]`:

```json
{"version": 1, "threadId": "discussion-uuid", "submissionId": "submission-uuid"}
```

The model-visible prompt also contains `[Zed discussion <id>]`, derived from the same ID.
Pi can associate follow-ups with earlier turns in its existing session context; the entire
history is not pasted into each request. An ID is not history retrieval: compaction or a
session switch can lose earlier context, and no retrieval mechanism is implemented yet.
Zed builds this prompt header; that refinement alone needed no bridge update. The persistence
feature described below does require an updated adapter.

A successful `end_turn` prompt response returns those IDs plus `text` under the same key.
Missing/mismatched metadata, disconnection, or provider failure produces an inline error;
cancellation is labeled separately. There is no automatic retry. The extension captures completed assistant text
and responds only after `agent_settled`. User/custom-message interleaving during the review
causes an attribution error rather than putting an unrelated answer under the code.

Buffer anchors preserve the selection across edits before it. Changed selected text renders
an **Outdated** warning with the original excerpt and retains the reply. The first slice was
memory-only; the remote persistence section below now describes saving and restoring posted
comments. History retrieval after compaction, retry reconciliation, diff-side support,
rename recovery, and reattachment UI remain unimplemented. **This does not complete PR 2.**

### Queue ownership and safety

`AcpThread::send` cancels an existing legacy ACP turn, so concurrent calls are not a safe
way to enqueue comments at the bridge. Inline reviews wait in a Zed-owned FIFO keyed by
`AcpThread` entity, and dispatch only when the thread is idle and no inline review is in
flight. The native message-editor queue requires message-editor entities and has no inline
completion ownership; this focused queue uses the same canonical ACP submission path
without modifying the shared ACP implementation or introducing a second transport.

Scope: one attached Agent Panel thread. Separate threads/adapters aimed at the same pi
process are not globally queued; the bridge's existing busy error protects the shared run.
Manual Agent Panel prompts can interrupt a running review through Zed's normal behavior.
**Running** means dispatched to ACP; the bridge may still be waiting for terminal work.

On a running failure/cancellation, queued comments are retained in the editor but marked
**Not sent** and removed from the execution queue. They are not auto-retried or automatically
resumed by later posts. Check the transcript before reposting. Cancelling an individual
queued comment removes only that job and leaves FIFO order intact. Closing a source editor
before dispatch drops its unsent jobs when the queue is next pumped and records them as
**Not sent**. The execution queue remains in memory; posted comments are saved remotely.

### Validation

- `pnpm check`, `pnpm test` (21 tests), `pnpm build`: passed on macOS.
- `cargo build --locked`: passed after final changes on Xcode 27.2 / Rust 1.98.1.
- `cargo test --locked -p editor review --lib`: passed (26 tests, including 2 new tests).
- `cargo test --locked -p agent_ui inline_review --lib`: passed (4 tests), covering exact reply correlation,
  model-visible discussion metadata, FIFO across A/B/follow-up-A, queued cancellation without
  an ACP cancel call, and failure without sending/retrying remaining jobs.
- GPUI coverage verifies posting the exact full-line excerpt/path, exclusion of the trailing
  line, retention through edits before selection, outdated detection inside selection, and
  refusal of unsaved buffers. Follow-up posts share a discussion ID and Pi replies have a
  distinct author and Markdown entity. Protocol tests verify exact IDs, sequential submissions,
  busy terminal work versus interleaving, cancellation, provider failure and malformed input.
- The debug linker warns that `__eh_frame` exceeds 16 MiB; build and tests still succeed.
- The user confirmed the initial end-to-end SSH inline flow. Remaining manual checks:
  separate Pi author/Markdown layout, burst posting, queued cancellation, discussion headers
  in terminal pi, two different ranges, changed-code warning, and failure display. Full repository tests/clippy and a new real
  provider smoke test have not been run.

### Discussion/queue refinement decision ledger (least-confident first)

1. A failed/stopped running review marks all remaining queued jobs **Not sent**, rather than
   automatically proceeding after uncertain delivery. Question: should a later explicit
   resume action preserve the execution queue instead?
2. FIFO lives in Zed per attached ACP thread, not globally across clients of a pi process.
   The existing ACP v1 send path interrupts prior turns; a bridge-only queue cannot fix that.
   Question: is cross-window/cross-client queue coordination needed beyond this workflow?
3. A discussion is the existing exact anchored range within one editor. IDs survive overlay
   dismissal but not editor closure/restart. Switching pi sessions does not restore history.
4. Keep wire `threadId` as the discussion ID and include it in the prompt built by Zed.
   This reuses the current protocol and avoids requiring another remote bridge deployment.
5. Use separate author rows with a Pi label/Sparkle icon and Zed's existing Markdown renderer,
   rather than real accounts or a second comment UI. Replies remain paired with their posts.
6. Queue snapshots capture the selected code at posting time, not dispatch time, so intervening
   code edits cannot silently change what the user submitted. Outdated detection remains active.
7. Queued cancellation is local and race-safe: once dispatched, a stale cancel click does
   nothing. Running cancellation stays in the Agent Panel and can affect shared terminal work.
8. Original selected-agent capture remains unchanged. Pending work retains its target even if
   the Agent Panel selection changes. Editor closure discards unsent local work.

### Close-button follow-up

Implemented and built locally; manual acceptance pending. `cargo test --locked -p editor
review --lib` passed all 27 tests, including a regression that keeps a second discussion
open, preserves a draft, does not invoke queued cancellation, and accepts a reply while the
first discussion is hidden. `cargo build --locked` and `git diff --check` passed.

This is **not disk persistence**. Closing the editor/restarting Zed still loses the in-memory
comments. The existing generic Escape/dismiss-all behavior is unchanged; if it removes the
markers, the comment data remains in memory and the action can reopen the original range.

Persistence investigation: `crates/editor/src/persistence.rs` already uses workspace/file
keys for `file_folds`, specifically to survive tab closure and editor-row cleanup. That is
the proposed pattern for review storage too. Storage location/retention scope still needs
confirmation before adding the schema: local Zed workspace DB on the Mac versus data shared
with the remote project. No persistence migration or background storage mechanism was added.

#### Close-button decision ledger (least-confident first)

1. Preserve native per-start-line grouping for now. A different range starting on a line
   with a retained discussion is rejected explicitly rather than moving that discussion.
2. The X means collapse, not delete; the same block becomes a reopen marker. It retains
   input drafts and callbacks, so closing UI cannot cancel or orphan in-flight work.
3. Keep Escape/dismiss-all semantics unchanged rather than changing global editor keyboard
   behavior as part of this targeted fix. Their removal of overlays is not comment deletion.
4. Proposed persistence is workspace-local/file-keyed, following Zed's existing file-fold
   storage, but the user must confirm whether remote-project sharing is desired.

### Remote user-level persistence

The user approved storing discussions on Ubuntu outside project directories, rather than
in the Mac's workspace DB or a repository `.zed/` directory. The adapter now handles the
versioned `_zed-pi-live/review-store` ACP extension directly. Reads/writes do not invoke pi,
create another agent, send a model prompt, or interrupt an active ACP turn.

Storage: `$XDG_DATA_HOME/zed-pi-review/<sha256(canonical-project-cwd)>/<submission-uuid>.json`,
falling back to `~/.local/share/zed-pi-review/`. Each post contains the discussion ID, source
path, original lines/excerpt, up to two context lines on each side, comment, timestamp, outcome,
and paired Pi reply. The original post is immutable; its final snapshot is published once in
`<submission-uuid>.json.completed`. Readers combine the two, rejecting inconsistent source
metadata. This also prevents simultaneous completion requests from replacing each other.
Directories are private (0700); files are private (0600). UUID validation,
no-follow reads, owner/mode checks, bounded records/responses, and atomic publication protect
the store. Different posts use different files, including concurrent follow-ups to one
shared discussion; initial creation cannot overwrite an existing post. A post's original
source/comment are immutable, and a terminal outcome cannot be replaced through this API.

Zed saves each post before it can leave the existing FIFO. Cancellation while saving still
removes the job immediately; its final stored cancellation waits for the initial write.
Save failures are shown inline and in a workspace toast, never retried automatically.
Finished replies are saved even when their source editor has closed. If Zed exits before
receiving/saving an outcome, the record remains pending; restoring it says interrupted or
possibly running elsewhere, with no automatic resend or queue recovery.

Restoration runs when activating a regular file with a pi-live thread available, before the
comment action opens its input, and via **agent: restore pi reviews**. If the Agent Panel
was not ready when a file opened, use that action after reconnecting. Restored discussions
appear as collapsed **Show discussion** markers. Repeated loads deduplicate by submission
ID, can refresh outcomes for previously restored pending records, and preserve stable
discussion IDs for follow-ups. Storage remains independent of the selected live pi session,
but requires an active adapter connection. It does not restore pi's model context after
compaction/session switching.

Only a unique exact context match is reattached, including after lines move. Changed,
deleted, ambiguous, or conflicting ranges are reported as outdated/unattachable and remain
intact on disk. There is no guessed line fallback and no reattachment UI yet; unmatched
history is not rendered under arbitrary code. Project/file renames require manual migration
for now. Posted comments and replies persist; unsubmitted drafts and collapsed/open UI state
do not. Existing comments in an already-running older Zed binary are not migrated—copy any
needed text before quitting it.

Validation on macOS and Ubuntu: `pnpm check`, all 27 bridge tests, `pnpm build`; on macOS,
all 29 editor review
tests, 6 agent-UI review tests, the ACP extension round-trip/error test, and
`cargo build --locked` passed. Coverage includes an actual CLI process restart with a real
user-level file store, no project files, separate projects/symlink cwd, concurrent posts,
corruption/unsafe paths, initial-save failure without dispatch, cancellation during saving,
fresh-editor restoration, folded/shifted/ambiguous/overlapping anchors, authored replies, refresh,
and discussion identity. New real-provider and manual GUI restart acceptance remain pending.

#### Persistence decision ledger (least-confident first)

1. Outdated/unmatched saved discussions stay on disk and produce a visible warning instead
   of getting a guessed inline location. A dedicated orphan/reattachment UI is still deferred.
   If asking were free: should that UI be the next slice?
2. Zed writes the completed reply; quitting before its response/save leaves an uncertain
   pending record, not a recoverable execution queue. Check terminal history before reposting.
3. Persist posted comments, not unfinished input drafts or open/closed overlay state. Restore
   markers collapsed to avoid reopening large overlays unexpectedly.
4. Use immutable per-submission post/completion files rather than a shared mutable discussion
   file. Exclusive atomic publication prevents both lost follow-ups and conflicting terminal
   outcomes, without locks, background workers, or retry queues. There are no shared edit/delete
   operations or live cross-client synchronization.
5. Use the adapter's canonical session cwd as project identity and absolute host file paths.
   Separate clones/paths remain separate; moving a project/file is not guessed automatically.
6. Use the existing ACP connection's standard underscore-prefixed extension mechanism, not
   model prompts or a second SSH subprocess. Older adapters fail visibly and need updating.
7. Retain data indefinitely until explicitly removed; do not introduce automatic cleanup,
   retention settings, or a local duplicate database. Existing storage is private to the
   remote OS account, not protected from processes already running as that user.
8. Bound each stored record and each list response to 4 MiB, below the existing 8 MiB ACP
   transport limit. Exceeding the limit fails visibly; no truncation or pagination is invented.
9. Capture up to two complete context lines on each side and require a unique exact match;
   nearby edits can deliberately make restoration conservative. Reuse source anchors directly
   for overlay creation, not a round trip through display rows, so folds cannot change the
   reviewed range.

### Discussion pointer-event follow-up

The user reported that the lower discussion could not be hidden/reopened, both reopen
buttons highlighted together, and code behind the discussion received clicks/hover tooltips.
A real GPUI pointer regression reproduced the lower X failing before the fix. Earlier tests
only invoked collapse/reopen methods directly and therefore missed the rendered-control bug.

Each expanded/collapsed discussion now scopes its child element IDs under its existing
prompt-editor entity ID. Both surfaces use GPUI's `block_mouse_except_scroll`, preventing
code-editor clicks/hover underneath without blocking normal scrolling or nested inputs.
The comment-section header toggles its captured hunk, not whichever prompt has focus (or
the first overlay). The submit button likewise focuses/submits its own prompt explicitly.
Keyboard action behavior remains unchanged.

`cargo test --locked -p editor review --lib` passed 30 tests; the new pointer test hides the
lower discussion, hides the upper one, reopens the lower one, types in its actual input,
folds/unfolds its comment section with the source editor focused, clicks its background,
and submits to the correct discussion. It checks unchanged source text/selections and
blocked source-editor hover. Both discussions include rendered Pi Markdown replies.
All 6 agent-UI review tests, `cargo build --locked`, and `git diff --check` also passed.
Manual acceptance in the running Mac/SSH window is pending; the rebuilt custom Zed needs
relaunching. No adapter/pi-extension update, protocol change, or saved-data migration is
required. Snippet repetition in follow-up prompts is unchanged by this UI fix.

#### Pointer-event decision ledger (least-confident first)

1. Preserve the existing keyboard toggle's focused/first-discussion fallback. Only pointer
   controls gain explicit ownership; changing keyboard semantics is outside this bug fix.
2. Use `block_mouse_except_scroll` rather than swallowing every event. Inputs and Markdown
   remain interactive, and wheel scrolling can continue through the existing editor path.
3. Scope widget state by the existing prompt entity, not line numbers or a new persistent
   field. That identity survives hiding/reopening and source-line movement.

### Original slice decision ledger (superseded where noted above)

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
