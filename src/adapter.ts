import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { promptText, textUpdate } from "./content.js";
import { reviewRequest } from "./review.js";
import { accessReviewStore, reviewDataDirectory, REVIEW_STORE_METHOD, storeRequest } from "./review-store.js";
import { connectSession, discoverSessions, ENDPOINT_ID, initialization, runtimeDirectory } from "./transport.js";

type Attachment = { endpointId: string; connection: acp.ClientConnection };
type Thread = { cwd: string; attachment?: Attachment; attaching: boolean; discovery?: Promise<void> };

export function createAdapter(directory = runtimeDirectory(), reviewDirectory = reviewDataDirectory()): acp.AgentApp {
  const threads = new Map<string, Thread>();
  let front: acp.AgentConnection;

  async function tell(sessionId: string, text: string): Promise<void> {
    await front.client.notify(acp.methods.client.session.update, { sessionId, update: textUpdate(text) });
  }

  async function list(cwd?: string | null): Promise<acp.SessionInfo[]> {
    const sessions = await discoverSessions(directory);
    if (!cwd) return sessions;
    const canonicalCwd = await realpath(cwd);
    const matching: acp.SessionInfo[] = [];
    for (const session of sessions) {
      if (await realpath(session.cwd).catch(() => undefined) === canonicalCwd) matching.push(session);
    }
    return matching.length ? matching : sessions;
  }

  async function selectionHelp(sessionId: string, thread: Thread, autoAttach = false): Promise<void> {
    const sessions = await list(thread.cwd);
    if (front.signal.aborted || thread.attachment || thread.attaching) return;
    if (autoAttach && sessions.length === 1 && await realpath(sessions[0]!.cwd).catch(() => undefined) === thread.cwd) {
      try {
        await attach(sessionId, thread, sessions[0]!.sessionId);
        return;
      } catch (error) {
        await tell(sessionId, `Automatic attachment failed: ${String(error)}\nChoose a session below to retry explicitly.\n`);
      }
    }
    await tell(sessionId, sessions.length
      ? "Choose the existing pi session to attach to:\n\n" + sessions.map((session) =>
        `- ${session.title}: \`/attach ${session.sessionId}\`\n  ${session.cwd}`).join("\n") +
        "\n\nYou can also select a live session from Zed's agent session history. Use /sessions to refresh."
      : "No live pi sessions found. Load the bridge extension in your terminal pi, then send /sessions. No new pi process will be started.");
    await front.client.notify(acp.methods.client.session.update, {
      sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [
        { name: "attach", description: "Attach to an existing live pi session", input: { hint: "session ID from /sessions" } },
        { name: "sessions", description: "List matching live pi sessions, or all sessions if none match" },
      ] },
    });
  }

  async function attach(sessionId: string, thread: Thread, endpointId: string, cwd = thread.cwd): Promise<void> {
    if (!ENDPOINT_ID.test(endpointId)) throw acp.RequestError.invalidParams(undefined, "Use the complete live session ID from /sessions");
    if (thread.attachment || thread.attaching) throw new acp.RequestError(-32000, "This thread is already attached or attaching");
    thread.attaching = true;
    let connection: acp.ClientConnection | undefined;
    try {
      connection = await connectSession(directory, endpointId, (notification) =>
        front.client.notify(acp.methods.client.session.update, { ...notification, sessionId }));
      await connection.agent.request(acp.methods.agent.session.load, {
        sessionId: endpointId, cwd, mcpServers: [],
      }, { cancellationSignal: AbortSignal.timeout(10_000), stopWaitingOnCancel: true });
      if (front.signal.aborted) throw new Error("Zed disconnected while attaching");
      thread.attachment = { endpointId, connection };
      void connection.closed.then(() => {
        if (!front.signal.aborted) void tell(sessionId,
          "\n[Live pi disconnected. Work already submitted may continue in the terminal. Nothing will be resent. Reopen the live session to reconnect.]\n").catch(() => {});
      });
      await front.client.notify(acp.methods.client.session.update, {
        sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      });
    } catch (error) {
      connection?.close();
      if (error instanceof acp.RequestError) throw error;
      throw new acp.RequestError(-32000, `Could not attach to live pi: ${String(error)}`);
    } finally {
      thread.attaching = false;
    }
  }

  return acp.agent({ name: "zed-pi-live" })
    .onConnect((connection) => {
      front = connection;
      void connection.closed.then(() => {
        for (const thread of threads.values()) thread.attachment?.connection.close();
        threads.clear();
      });
    })
    .onRequest(REVIEW_STORE_METHOD, storeRequest, async ({ params }) => {
      const thread = threads.get(params.sessionId);
      if (!thread) throw acp.RequestError.sessionNotFound(params.sessionId);
      try { return await accessReviewStore(thread.cwd, params, reviewDirectory); }
      catch (error) { throw new acp.RequestError(-32000, `Review storage failed: ${String(error)}`); }
    })
    .onRequest(acp.methods.agent.initialize, () => initialization)
    .onRequest(acp.methods.agent.session.list, async ({ params }) => ({ sessions: await list(params.cwd) }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const sessionId = `select-${randomUUID()}`;
      const thread: Thread = { cwd: await realpath(params.cwd), attaching: false };
      threads.set(sessionId, thread);
      // Zed discards updates for sessions it has not received a session/new response for.
      thread.discovery = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => selectionHelp(sessionId, thread, true))
        .catch((error: unknown) => { front.close(error); });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.load, async ({ params }) => {
      if (threads.has(params.sessionId)) throw new acp.RequestError(-32000, "Session already open on this connection");
      const thread: Thread = { cwd: await realpath(params.cwd), attaching: false };
      threads.set(params.sessionId, thread);
      try { await attach(params.sessionId, thread, params.sessionId); }
      catch (error) { threads.delete(params.sessionId); throw error; }
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, signal }) => {
      const thread = threads.get(params.sessionId);
      if (!thread) throw acp.RequestError.sessionNotFound(params.sessionId);
      await thread.discovery;
      if (thread.attaching) throw new acp.RequestError(-32000, "Attachment is in progress");
      if (!thread.attachment) {
        if (reviewRequest(params.prompt)) throw new acp.RequestError(-32000, "Attach pi-live before posting an inline review. This comment was not sent.");
        const text = promptText(params.prompt).trim();
        if (text.startsWith("/attach ")) {
          const endpointId = text.slice(8).trim();
          const session = (await list()).find((candidate) => candidate.sessionId === endpointId);
          if (!session) throw acp.RequestError.invalidParams(undefined, "Choose a live session ID from /sessions");
          await attach(params.sessionId, thread, endpointId, session.cwd);
        }
        else {
          if (text !== "/sessions") await tell(params.sessionId, "Not attached: your message was not sent or queued. Attach first, then submit it again.\n");
          await selectionHelp(params.sessionId, thread);
        }
        return { stopReason: "end_turn" };
      }
      const { connection, endpointId } = thread.attachment;
      if (connection.signal.aborted) throw new acp.RequestError(-32000, "Live pi disconnected. Reopen the session; nothing was resent.");
      return connection.agent.request(acp.methods.agent.session.prompt, {
        ...params, sessionId: endpointId,
      }, { cancellationSignal: signal, stopWaitingOnCancel: true });
    })
    .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
      const attachment = threads.get(params.sessionId)?.attachment;
      if (attachment) await attachment.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: attachment.endpointId,
      });
    });
}
