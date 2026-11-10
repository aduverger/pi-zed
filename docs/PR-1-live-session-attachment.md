# PR 1: Attach Zed to a live terminal pi session

## Outcome
Zed's existing Agent Panel and the terminal address one running pi process.
No new pi process, saved-session resume, Rex integration, or Zed modification.

## Implementation plan
1. Build a TypeScript pi extension and a stdio ACP adapter using the official ACP SDK.
2. On pi session startup, expose ACP over a same-user Unix socket in a private directory.
   Discover only live endpoints; never read credentials or reopen session files.
3. List live sessions with name, cwd and process identity through ACP session/list.
   session/load attaches to the explicitly chosen endpoint and replays its transcript.
   New Zed threads automatically attach to a unique canonical-cwd match. Otherwise they
   list matching sessions, falling back to all live sessions when none match, with /attach.
4. Submit user text and embedded text context through pi's existing message API.
   Stream assistant text and tool activity. Keep permissions/dialogs in the terminal.
5. Serialize bridge prompts, wait for terminal work to settle, support cancellation, and
   surface disconnects without retrying accepted work. Observe terminal-originated turns.
6. Clean up connections on reload, session replacement, branch navigation and exit.
   A stale Zed attachment must never silently follow a new pi session.
7. Add tests over real Unix sockets and ACP, plus a real pi runtime integration check.

## Acceptance
- Start pi in a terminal; attach from Zed; submit a unique fact and receive a streamed reply.
- Continue from the terminal and recall that fact without switching/resuming a session.
- While terminal work runs, queue a Zed prompt; cancel the waiting prompt without aborting terminal work.
- Disconnect/reconnect and verify history is restored without replaying the prompt.
- Reload/replace the pi session and verify the old attachment fails explicitly.
- Keep any unavailable GUI/provider checks listed as release prerequisites.

## Scope boundaries
Same host/user on macOS/Linux; text and embedded text resources only. No remote transport,
model picker, ACP filesystem/terminal/MCP delegation, inline annotations or persisted comment IDs.
No publishing or changes to the user's global pi/Zed configuration in this implementation task.

## Implementation status and evidence
Implemented locally on `feat/live-session-attachment`; no remote PR published.

- `npm run check`: passed.
- `npm test`: 12 passing tests using real Unix sockets/ACP and controlled pi lifecycle fixtures.
- `npm run build`: passed.
- `python3 scripts/smoke-tui.py`: passed against a real pi 1.5.1 TUI and configured
  openai-codex model on Linux/Node 26. The test verified the pi PID, an ACP-originated
  unique token visible in the terminal, terminal recall streamed to ACP, and reconnect
  replay of both answers without resubmission. The test process had no tools or saved session.
- No global pi/Zed settings were changed and no existing user session was modified.

Remaining release prerequisites: real Zed GUI selection/rendering/stop/reconnect, macOS,
Node 22, and hot installation/reload in the user's configured session. No graphical display
was available. Fixture tests cover shutdown and failure paths; they are not a claim that
all pi extensions or terminal permission dialogs have been tested end to end.

## Auto-discovery follow-up

Implemented on `feat/inline-review-threads` before custom Zed work:

- Start a new thread: auto-attach the sole canonical-cwd match; otherwise list matching
  live sessions, or all live sessions if none match. Never auto-attach a different cwd.
- The ACP history list uses the same matching/fallback rule. `/sessions` refreshes selection.
- Send initial notifications after the new-session response so Zed can register the thread.
- Hold prompts until startup discovery finishes; if unattached, explain that they were not sent.
- Failed automatic attachment is visible and permits explicit retry; no background retry.
- `pnpm check`, `pnpm test` (17 tests), and `pnpm build` passed. Tests cover unique/multiple/no
  matches, canonical symlinks, cross-directory explicit selection, busy failure/retry, empty
  discovery/refresh, notification ordering, streaming, and existing lifecycle failures.
- New startup behavior still needs manual Zed verification. No new real-provider smoke run.

### Follow-up decision ledger (least-confident first)

1. Busy unique matches fail visibly and require explicit retry, preserving existing idle-only
   attachment rather than introducing background waits. Question: should startup wait for idle?
2. Auto-attach only on new-thread startup; `/sessions` remains a list refresh. Question: should
   an explicit refresh also auto-attach when one match subsequently appears?
3. Exact canonical cwd matching treats symlinks as equivalent, but not parent/child paths.
4. Listing all sessions means all reachable bridge endpoints for this host/user. Rex processes
   or saved SDK sessions cannot provide the private live connection required for attachment.
5. Explicit cross-directory `/attach` uses the chosen session's advertised cwd for loading;
   the extension's cwd validation remains intact, and pi's working directory does not change.

## Decision ledger
Implementation choices where the request was silent, least-confident first:
1. Pi's injection API is fire-and-forget. Use a 30-second startup acknowledgement timeout
   and a visible `[Zed request <uuid>]` marker to correlate the matching run. Input hooks
   must preserve it. Timeouts report uncertain delivery, never resend. Question: should
   pi expose an awaited submission API upstream instead?
2. Originally, new ACP threads required explicit selection. The auto-discovery follow-up
   below supersedes that choice. Native session/list + session/load remains available.
3. Attach while idle for a coherent transcript snapshot. Match canonical working directories
   exactly for automatic attachment, rather than guessing between projects/worktrees.
   Explicit /attach may select another cwd. Question: should subdirectories
   also be eligible once there is a concrete workflow for them?
4. Allow one pending Zed prompt per pi process; wait until terminal work settles rather than
   steering it. Further Zed submissions fail explicitly. Cancelling a waiting prompt only
   removes it; cancelling a running prompt aborts the shared run, including terminal follow-ups.
   Question: is this shared cancellation behavior the desired UX?
5. Closing Zed drops a still-waiting prompt but leaves submitted work running. Reload/session
   replacement gets a fresh endpoint identity; branch navigation disconnects readers.
   Question: should later versions recover unsubmitted drafts across disconnects?
6. Mirror session-wide terminal text and tool lifecycle events. Replay existing user/assistant
   text and top-level tool results; omit thinking, custom pi UI and detailed live tool output.
   Text resources are supported; binary input is rejected. Question: which omitted surfaces
   matter after the text-only proof?
7. Keep auth, tools, model selection and permission dialogs in pi. Do not delegate ACP MCP,
   filesystem or terminal operations. The endpoint grants the same agent authority to the
   current OS user; private directory/socket modes protect against other users, not that user.
8. Bound transport messages/outbound buffering to 8 MiB and connection/load waits to 3/10
   seconds; fail visibly on oversized/slow clients. Ignore stale sockets without deleting
   another process's files. No token store, registry metadata file or background broker.
9. Use the official ACP SDK on both transports and TypeScript/Node for the extension/adapter.
   Pin the tested pi development API at 1.5.1; use compiled local-package installation.
   Use controlled fixtures for deterministic failures and a separate opt-in real-provider
   pseudo-terminal smoke test for the principal flow. No synthetic test is presented as a
   Zed GUI acceptance test.
