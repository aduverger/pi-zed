# Zed ↔ live pi

Attach Zed's existing Agent Panel to a **running terminal pi process**. The adapter never
starts pi, opens a saved session, or uses Rex. This is a local prototype, not a Zed UI extension.

Plans: [PR 1 — live attachment](docs/PR-1-live-session-attachment.md) ·
[PR 2 — inline review threads](docs/PR-2-inline-review-threads.md).

## Requirements

- macOS or Linux; Node.js 22+.
- Pi **1.5.1** (the API version tested here), with a configured model/provider.
- Zed supporting custom ACP agents. Zed GUI behavior is not yet manually verified.
- Pi and the ACP adapter on the **same host and OS account**, with the same temporary
  directory environment. Remote attachment is not implemented.

## Build

```sh
pnpm install
pnpm build
```

## Load into your existing terminal pi

From a separate shell, install this local package (changes your pi configuration):

```sh
pi install /absolute/path/to/zed_review
```

Then run **/reload in the existing pi session** after it becomes idle. Its footer should
show `Zed live: <id>`. This preserves the conversation in the same process.

For a disposable new session instead:

```sh
pi -e /absolute/path/to/zed_review/dist/extension.js
```

After code changes, rebuild and reload pi. Do not load both installation methods at once.

## Configure Zed

Merge this entry into Zed's settings; replace both paths with absolute paths on the host
where pi runs. Use the actual Node executable if Zed does not inherit your shell PATH.

```json
{
  "agent_servers": {
    "pi-live": {
      "type": "custom",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/zed_review/dist/cli.js"]
    }
  }
}
```

Open the same working directory as pi.

1. Select **pi-live** in the Agent Panel.
2. Choose a live session from the agent session history, if your Zed version exposes it.
   The name includes the pi process ID.
3. Alternatively, start a pi-live thread. If exactly one live session matches the canonical
   working directory, it attaches automatically. Multiple matches are listed for selection;
   if none match, all live sessions are listed with their working directories.
   Send **/attach <full-id>** to select one, or **/sessions** to refresh the list.
4. Send a prompt. The user message and agent response appear in your terminal pi too.
   Terminal-originated user messages and streamed assistant replies also appear in Zed.

Discovery finds only running pi sessions with this bridge loaded, on the adapter's host
and OS account—not saved sessions or arbitrary pi processes visible in Rex. Selecting a
session from another directory is explicit; pi continues operating in its own directory.

Messages submitted during initial discovery wait for it to finish. If no attachment results,
they are **not queued or sent**. Attach while pi is idle; a failed automatic attachment shows
an error and leaves the selection commands available for explicit retry. `/sessions` refreshes
selection without automatically attaching. Once attached, messages go to pi.

## Shared-session behavior

- One Zed prompt may be pending per live pi process. If terminal work is active, the prompt
  waits for it to settle. Additional Zed prompts fail explicitly rather than silently queue.
- Cancel while waiting removes only the Zed prompt. Cancel after it starts aborts the
  **shared pi run**, which can include terminal follow-ups.
- Pi still owns tools, model configuration, permissions, dialogs, and all session state.
  Approve requests in the terminal, not Zed. Zed's own permission settings do not sandbox pi.
- Text and embedded text resources are supported. Resource links are passed as references,
  not fetched by the adapter. Images, audio and binary embedded resources are rejected.
- Tool start/completion status is streamed; detailed live tool output and thinking blocks
  are not mirrored. Existing user/assistant text and top-level tool results replay on load.
- Each injected prompt has a visible `[Zed request <uuid>]` prefix for run correlation.
  Input extensions must preserve this marker. Slash commands are not dispatched/expanded.
- Prompt completion waits for `agent_settled`, not `agent_end`, so pi's retries finish first.
  Terminal work submitted into that shared run may delay completion.
- Pi's public injection API is fire-and-forget. If no matching run starts within 30 seconds,
  Zed receives an explicit error; check pi's terminal for auth/input-hook failures. A late
  run is still possible: **do not blindly retry**. No automatic retry occurs in the bridge.

## Disconnects and session changes

Closing Zed never kills pi or aborts work already submitted. A still-waiting prompt is dropped.
Reopen a live session to replay the current branch's history; accepted prompts are never resent.

Reload, new/resume/fork, or pi exit closes the old endpoint. Explicitly select the new live
endpoint; there is no fallback to a saved conversation. Branch navigation disconnects readers
so they can explicitly reload the current branch. A selection-screen thread ID is not durable:
use the live session picker or a fresh /sessions → /attach after restarting the adapter.

## Security and limits

The extension exposes agent execution authority to processes running as your OS user.
It creates `$TMPDIR/zed-pi-live-<uid>/` (Node's temporary directory) with mode 0700 and
randomly named Unix sockets with mode 0600. Existing permissive, wrong-owner or symlinked
endpoint directories are refused. No TCP listener, credentials file, or authentication token
is created. Stale socket files are ignored, not reclaimed by another process.

Loading the extension enables this endpoint for every pi session in which it is loaded.
Do not install it in untrusted environments. It is not protection against another process
already running as your user.

Transport messages and queued outbound updates are limited to 8 MiB. A slow reader or
oversized transcript causes disconnection rather than unbounded buffering. There is no
ACP filesystem, terminal, or MCP delegation; pi's existing configuration remains authoritative.

## Validation

```sh
pnpm check
pnpm test
pnpm build
```

Tests use real Unix sockets and the official ACP SDK with controlled pi lifecycle fixtures.

Optional real-provider acceptance check (uses configured model credentials and consumes tokens):

```sh
pnpm test:live
```

This starts a separate disposable **real pi TUI in a pseudo-terminal**, with no tools, project
instructions or saved session. It sends a unique token through the real stdio adapter, verifies
the existing terminal process shows the interaction, types a recall question into that terminal,
and reconnects to verify history without resubmitting. It does not alter your existing session
or global configuration. It uses PI_PROVIDER/PI_MODEL when both are set, otherwise pi's default.

Still required before release: manually validate Zed's picker, /attach flow, stop button,
streaming display and reconnect behavior on your installed Zed/macOS or Linux version.
Inline review comments are deliberately deferred to PR 2.

## Remove

```sh
pi remove /absolute/path/to/zed_review
```

Run /reload in pi and remove the `pi-live` agent entry from Zed. No pi history is deleted.
