import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { promptText, textUpdate } from "./content.js";
import { connectSession, discoverSessions, ENDPOINT_ID, initialization, runtimeDirectory } from "./transport.js";

type Attachment = { endpointId: string; connection: acp.ClientConnection };
type Thread = { cwd: string; attachment?: Attachment; attaching: boolean };

export function createAdapter(directory = runtimeDirectory()): acp.AgentApp {
  const threads = new Map<string, Thread>();
  let front: acp.AgentConnection;

  async function tell(sessionId: string, text: string): Promise<void> {
    await front.client.notify(acp.methods.client.session.update, { sessionId, update: textUpdate(text) });
  }

  async function list(cwd?: string | null): Promise<acp.SessionInfo[]> {
    return discoverSessions(directory, cwd ? await realpath(cwd) : undefined);
  }

  async function selectionHelp(sessionId: string, cwd: string): Promise<void> {
    const sessions = await list(cwd);
    await tell(sessionId, sessions.length
      ? "Choose the existing pi session to attach to:\n\n" + sessions.map((session) =>
        `- ${session.title}: \`/attach ${session.sessionId}\`\n  ${session.cwd}`).join("\n") +
        "\n\nYou can also select a live session from Zed's agent session history. Use /sessions to refresh."
      : "No live pi sessions for this working directory. Load the bridge extension in your terminal pi, then send /sessions. No new pi process will be started.");
    await front.client.notify(acp.methods.client.session.update, {
      sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [
        { name: "attach", description: "Attach to an existing live pi session", input: { hint: "session ID from /sessions" } },
        { name: "sessions", description: "List live pi sessions for this working directory" },
      ] },
    });
  }

  async function attach(sessionId: string, thread: Thread, endpointId: string): Promise<void> {
    if (!ENDPOINT_ID.test(endpointId)) throw acp.RequestError.invalidParams(undefined, "Use the complete live session ID from /sessions");
    if (thread.attachment || thread.attaching) throw new acp.RequestError(-32000, "This thread is already attached or attaching");
    thread.attaching = true;
    let connection: acp.ClientConnection | undefined;
    try {
      connection = await connectSession(directory, endpointId, (notification) =>
        front.client.notify(acp.methods.client.session.update, { ...notification, sessionId }));
      await connection.agent.request(acp.methods.agent.session.load, {
        sessionId: endpointId, cwd: thread.cwd, mcpServers: [],
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
    .onRequest(acp.methods.agent.initialize, () => initialization)
    .onRequest(acp.methods.agent.session.list, async ({ params }) => ({ sessions: await list(params.cwd) }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const sessionId = `select-${randomUUID()}`;
      const thread: Thread = { cwd: await realpath(params.cwd), attaching: false };
      threads.set(sessionId, thread);
      await selectionHelp(sessionId, thread.cwd);
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
      if (thread.attaching) throw new acp.RequestError(-32000, "Attachment is in progress");
      if (!thread.attachment) {
        const text = promptText(params.prompt).trim();
        if (text.startsWith("/attach ")) await attach(params.sessionId, thread, text.slice(8).trim());
        else {
          if (text !== "/sessions") await tell(params.sessionId, "Not attached: your message was not sent or queued. Attach first, then submit it again.\n");
          await selectionHelp(params.sessionId, thread.cwd);
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
