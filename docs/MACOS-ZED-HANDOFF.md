# Handoff: build and validate custom Zed on the MacBook

## Instructions for the laptop pi session

Take ownership of the macOS Zed build and GUI validation for our inline-review work. First prove an **unmodified pinned Zed build** works, including SSH and our existing live pi attachment. Do not start implementing the whole review feature before this baseline passes.

Read repository instructions before changing files. Preserve the user's installed Zed, settings, credentials, and existing terminal pi session. Do not push or create a PR without authorization. Use pnpm for the TypeScript bridge.

## Context and approved direction

- Zed runs on the MacBook; the working project and existing terminal pi session run on Ubuntu over SSH.
- PR 1 attaches Zed's existing Agent Panel to that **same running pi session** through a private Unix socket and an ACP adapter. The user has manually confirmed this works. It does not launch a separate pi agent.
- Repository: https://github.com/aduverger/zed_review
- PR 2 extends Zed's native review UI: comments in regular file editors and diffs, automatic submission, replies under the selected lines, persistent IDs, correct old/new/deleted-line anchors, and explicit outdated state.
- The user approved using the latest stable release and building a custom Zed on the Mac.
- Do not build a separate panel, embed Rex, or replace the proven live-session attachment.

## Pin and checkout

The server investigation selected stable tag **v1.27.0**, commit:

```
c84af5b99cbc366d675064e52b23664a015b6e35
```

Keep this pin for reproducibility rather than silently advancing to a newer release. Verify the tag resolves to this commit; stop and report a mismatch.

In a new local checkout (adapt the parent directory):

```sh
git clone --depth 1 --branch v1.27.0 https://github.com/zed-industries/zed.git zed-pi-review
cd zed-pi-review
git rev-parse HEAD
git switch -c feat/pi-inline-review
```

Read `AGENTS.md`, any applicable nested instructions, `rust-toolchain.toml`, and `docs/src/development/macos.md`. Follow repository-required review notices as well.

## Current server state — do not assume this is on GitHub

Server bridge checkout:

```
/home/ubuntu/code/aduverger/zed_review
branch: feat/inline-review-threads
```

Auto-discovery follow-up implemented locally (check Git history/status before transferring):

- `src/adapter.ts`: defer initial command notifications until after `session/new`; auto-attach a unique canonical-cwd match, otherwise list matches or all sessions when none match.
- `test/bridge.test.ts`: ordering and discovery regression tests. `pnpm check`, all 17 tests, and `pnpm build` passed; new behavior is not yet manually verified in Zed.

Separate uncommitted, **unvalidated review-protocol** work:

- `src/review.ts` (new): draft versioned review correlation metadata.
- `src/extension.ts`: draft final-reply attribution and rejection when unrelated messages interleave.
- User-created `pnpm-lock.yaml` and `pnpm-workspace.yaml` are untracked; preserve them.

Server Zed checkout:

```
/home/ubuntu/code/aduverger/zed-pi-review
branch: feat/pi-inline-review
```

This contains **no review implementation yet**. Only the repository-required README review notice was added. There is no custom Zed patch to apply or compile yet.

Server implementation is paused for this handoff. A fresh GitHub clone will not contain the uncommitted bridge work. For baseline testing, use the already-working remote setup. Before relying on draft protocol code, obtain an explicit snapshot/commit from the server and record its revision; do not overwrite it or assume it was pushed.

## Step 1: establish macOS build prerequisites

Inspect first:

```sh
sw_vers
uname -m
df -h .
xcode-select -p
xcodebuild -version
xcrun --show-sdk-path
rustup --version
cmake --version
```

Install missing dependencies according to the pinned build guide, with user approval for privileged/system changes:

- Full Xcode with macOS components, opened once to complete setup; command-line tools alone may not suffice.
- Xcode selected as the active developer directory, license accepted.
- Rust via rustup, using the checkout's pinned toolchain rather than overriding it.
- CMake (`brew install cmake` if Homebrew is already available).

The inspected pin requests Rust **1.98.1**; confirm in `rust-toolchain.toml`. Release bundling requires **Xcode 26 / macOS 26 SDK or newer** according to this pin's guide. Start with a debug build, not app bundling/signing.

Do not run destructive cleanup, change system security settings, or replace `/Applications/Zed.app` just to make a build work. Report prerequisite blockers directly.

## Step 2: build and launch the baseline

Use the pinned guide's debug path:

```sh
cargo run -- /absolute/path/to/a/small/scratch-project
```

Keep the scratch project outside the Zed source checkout to avoid build-environment/rust-analyzer cache invalidation. Record the exact command, toolchain, duration, and any errors. Verify the window belongs to the custom build rather than the installed app; record its About/version details.

No workspace-wide test run is needed merely to establish that an unmodified build launches. Do not substitute a release bundle for this initial check.

## Step 3: preserve and verify SSH + live attachment

1. Open the user's existing SSH project from the custom Zed build.
2. Reuse the working `pi-live` Agent Panel configuration, without deleting the registry `pi-acp` entry. Inspect where it is configured and which host executes the adapter; do not guess or put Ubuntu paths into a locally executing command.
3. Attach to the existing terminal pi session. Do not create another pi process to make the test pass.
4. Send a unique harmless fact from Zed, observe the interaction in the terminal, then ask for that fact from the terminal. Confirm shared context.
5. Send another message from Zed and confirm the session remains usable.

A custom dev build may encounter remote-server version/distribution issues over SSH. Treat this as a separate acceptance gate: record client/server versions and exact failure. Inspect Zed's supported remote-development setup before changing remote binaries; do not overwrite the user's working remote installation blindly.

The initial command-registration fix and auto-discovery have automated coverage but need manual Zed validation. With the updated adapter, a new thread should attach automatically if exactly one live session matches its cwd. If `/sessions` is absent in an unattached thread, document it and use the already-proven selection workflow where possible. Do not conflate bridge behavior with a macOS build failure.

## Step 4: report before expanding implementation

Return:

- Local checkout path, branch, exact Zed commit, macOS/CPU, Xcode/SDK and Rust versions.
- Reproducible build and launch commands.
- Pass/fail evidence for launch, SSH workspace, and shared pi context.
- Blockers and whether any settings/system dependencies were changed.
- Location of logs and any commits/patches; no credentials or session transcripts containing secrets.

After the baseline, coordinate the next implementation slice with the user/server session. Do not duplicate bridge changes in parallel.

## Implementation map for the next slice

These are investigation leads, not a finished design or validated patch:

- `crates/editor/src/git.rs`: native `show_diff_review_overlay`, `submit_diff_review_comment`, `StoredReviewComment`, overlay rendering, and anchor cleanup. Reuse this UI rather than adding another panel.
- `crates/agent_ui/src/agent_ui.rs`: UI initialization. A focused integration module could wire a selection action to the active Agent Panel thread.
- `AgentPanel::active_agent_thread`: identify the selected target, then retain that target for the submission rather than following later focus changes.
- `AcpThread::send`: canonical submission path; preserve permissions, status, cancellation, and transcript behavior.
- `crates/acp_thread/src/content.rs`: content-block metadata survives ACP v2/v1 conversion in the inspected source.
- `crates/agent_servers/src/acp/v1.rs`: session registration and update ordering.

Proposed first vertical slice: ordinary single-file selection → native inline comment → selected live pi → final reply in the originating inline thread. Explicitly reject unsupported selections instead of inventing diff-side semantics. This slice alone does **not** complete PR 2.

Draft bridge contract: a text content block carries `_meta["zed-pi-live/review"]` with `version: 1`, `threadId`, and `submissionId`. A successful prompt response returns matching metadata plus `text`. This is unfinished and needs tests before adoption. Never infer ownership from response prose or route unrelated terminal output into an inline thread. Retain failed comments and expose errors; do not automatically resubmit uncertain requests.

Full requirements and remaining acceptance cases are in `docs/PR-2-inline-review-threads.md`: persistence, diff sides, deleted lines, changed code, outdated anchors, reopen, and disconnect/retry safety remain outstanding.

## Handoff decision ledger

Least-confident first:

1. Custom-build SSH compatibility has not been verified; make it an explicit gate before investing in UI work.
2. Start with baseline build and live-attachment validation, not immediate full PR 2 implementation. This isolates laptop/toolchain problems from new code defects.
3. Keep the stable release already inspected rather than repinning during the handoff.
4. Leave server drafts untouched and uncommitted in this documentation task; they are not a tested handoff artifact.
