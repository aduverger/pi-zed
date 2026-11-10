import { randomBytes, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { realpath } from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { historyUpdates, promptText, textUpdate } from "./content.js";
import { initialization, MAX_MESSAGE_BYTES, privateDirectory, runtimeDirectory, secureSocket, socketPath, socketStream } from "./transport.js";

type Peer = {
  connection: acp.AgentConnection;
  loaded: boolean;
  writes: Promise<void>;
  queuedBytes: number;
};

type PendingPrompt = {
  peer: Peer;
  marker: string;
  text: string;
  phase: "waiting" | "submitted" | "running";
  cancelled: boolean;
  resolve: (response: acp.PromptResponse) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  error?: string;
};

export function installBridge(pi: ExtensionAPI, directory = runtimeDirectory()): void {
  let context: ExtensionContext;
  let server: Server | undefined;
  let endpoint: string | undefined;
  let sessionId = "";
  let pending: PendingPrompt | undefined;
  const peers = new Set<Peer>();

  function send(peer: Peer, update: acp.SessionUpdate): void {
    if (peer.connection.signal.aborted) return;
    const notification = { sessionId, update };
    const bytes = Buffer.byteLength(JSON.stringify(notification));
    peer.queuedBytes += bytes;
    if (peer.queuedBytes > MAX_MESSAGE_BYTES) {
      peer.connection.close(new Error("Reader is too slow or transcript exceeds the bridge buffer limit"));
      return;
    }
    peer.writes = peer.writes.then(() => peer.connection.client.notify(acp.methods.client.session.update, notification))
      .catch((error: unknown) => peer.connection.close(error))
      .finally(() => { peer.queuedBytes -= bytes; });
  }

  function broadcast(update: acp.SessionUpdate, except?: Peer): void {
    for (const peer of peers) if (peer.loaded && peer !== except) send(peer, update);
  }

  function finish(stopReason: acp.StopReason = "end_turn", error?: string): void {
    const request = pending;
    if (!request) return;
    pending = undefined;
    clearTimeout(request.timer);
    void request.peer.writes.then(() => {
      if (error) request.reject(new acp.RequestError(-32000, error));
      else request.resolve({ stopReason });
    });
  }

  function dispatch(): void {
    if (!pending || pending.phase !== "waiting") return;
    if (!context.isIdle() || context.hasPendingMessages()) {
      pending.timer = setTimeout(dispatch, 50);
      return;
    }
    const request = pending;
    request.phase = "submitted";
    request.timer = setTimeout(() => {
      if (pending !== request || request.phase === "running") return;
      finish("end_turn", "Pi did not acknowledge this prompt within 30 seconds. It may have been handled by an input extension or failed before startup. Check the terminal before retrying; it will not be resent automatically.");
    }, 30_000);
    try {
      pi.sendUserMessage(`${request.marker}\n\n${request.text}`, { deliverAs: "followUp" });
    } catch (error) {
      finish("end_turn", String(error));
    }
  }

  async function close(): Promise<void> {
    finish("end_turn", "The live pi runtime changed or stopped. Select a live session again.");
    for (const peer of peers) peer.connection.close();
    peers.clear();
    const closing = server;
    server = undefined;
    if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
    if (endpoint) await unlink(endpoint).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    endpoint = undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    await privateDirectory(directory);
    sessionId = randomBytes(16).toString("hex");
    endpoint = socketPath(directory, sessionId);
    server = createServer((socket) => {
      socket.on("error", () => {});
      let peer: Peer;
      const check = (id: string) => {
        if (id !== sessionId || !peer.loaded) throw acp.RequestError.sessionNotFound(id);
      };
      const app = acp.agent({ name: "pi-live-extension" })
        .onRequest(acp.methods.agent.initialize, () => initialization)
        .onRequest(acp.methods.agent.session.list, async ({ params }) => {
          if (params.cwd && await realpath(params.cwd) !== await realpath(context.cwd)) return { sessions: [] };
          return { sessions: [{
            sessionId, cwd: context.cwd,
            title: `${context.sessionManager.getSessionName() ?? "pi"} (PID ${process.pid})`,
          }] };
        })
        .onRequest(acp.methods.agent.session.load, async ({ params }) => {
          if (params.sessionId !== sessionId) throw acp.RequestError.sessionNotFound(params.sessionId);
          if (await realpath(params.cwd) !== await realpath(context.cwd)) {
            throw acp.RequestError.invalidParams(undefined, "Selected pi session belongs to a different working directory");
          }
          if (!context.isIdle() || pending) throw new acp.RequestError(-32000, "Pi is busy. Attach after it settles.");
          if (peer.loaded) throw new acp.RequestError(-32000, "This connection is already attached");
          peer.loaded = true;
          for (const update of historyUpdates(context.sessionManager.getBranch())) send(peer, update);
          send(peer, textUpdate("\n[Attached to the live terminal pi session. Permissions and dialogs stay in the terminal.]\n"));
          await peer.writes;
          return {};
        })
        .onRequest(acp.methods.agent.session.new, () => {
          throw new acp.RequestError(-32000, "This endpoint only attaches to its existing session. Use session/load.");
        })
        .onRequest(acp.methods.agent.session.prompt, async ({ params, signal }) => {
          check(params.sessionId);
          if (pending) throw new acp.RequestError(-32000, "Another Zed prompt is pending in this pi session. Wait for it to finish.");
          const text = promptText(params.prompt);
          if (!context.model) throw new acp.RequestError(-32000, "No model selected in pi. Select one in the terminal first.");
          const result = new Promise<acp.PromptResponse>((resolve, reject) => {
            pending = { peer, marker: `[Zed request ${randomUUID()}]`, text, phase: "waiting", cancelled: false, resolve, reject };
          });
          const disconnected = () => {
            if (pending?.peer === peer && pending.phase === "waiting") finish("cancelled");
          };
          signal.addEventListener("abort", disconnected, { once: true });
          if (!context.isIdle()) send(peer, textUpdate("\n[Waiting for the terminal agent to settle.]\n"));
          dispatch();
          try { return await result; }
          finally { signal.removeEventListener("abort", disconnected); }
        })
        .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
          check(params.sessionId);
          if (pending?.peer !== peer) return;
          pending.cancelled = true;
          if (pending.phase === "waiting") finish("cancelled");
          else if (pending.phase === "running") context.abort();
        });
      const connection = app.connect(socketStream(socket));
      peer = { connection, loaded: false, writes: Promise.resolve(), queuedBytes: 0 };
      peers.add(peer);
      void connection.closed.then(() => {
        socket.destroy();
        peers.delete(peer);
        if (pending?.peer === peer && pending.phase === "waiting") finish("cancelled");
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(endpoint, () => resolve());
      });
      await secureSocket(endpoint);
      ctx.ui.setStatus("zed-pi-live", `Zed live: ${sessionId.slice(0, 8)}`);
    } catch (error) {
      await close();
      throw error;
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (pending?.phase === "submitted" && event.messageType === "user" && event.prompt.includes(pending.marker)) {
      pending.phase = "running";
      clearTimeout(pending.timer);
      if (pending.cancelled) ctx.abort();
    }
  });
  pi.on("message_start", (event) => {
    if (event.message.role !== "user") return;
    const text = typeof event.message.content === "string" ? event.message.content
      : event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    broadcast(textUpdate(text, "user"), pending && text.includes(pending.marker) ? pending.peer : undefined);
  });
  pi.on("message_update", (event) => {
    if (event.assistantMessageEvent.type === "text_delta") broadcast(textUpdate(event.assistantMessageEvent.delta));
  });
  pi.on("message_end", (event) => {
    if (pending?.phase === "running" && event.message.role === "assistant") {
      pending.error = event.message.stopReason === "error" ? event.message.errorMessage ?? "Pi provider failed" : undefined;
    }
  });
  pi.on("tool_execution_start", (event) => broadcast({
    sessionUpdate: "tool_call", toolCallId: event.toolCallId, title: event.toolName,
    status: "in_progress", rawInput: event.args,
  }));
  pi.on("tool_execution_end", (event) => broadcast({
    sessionUpdate: "tool_call_update", toolCallId: event.toolCallId,
    status: event.isError ? "failed" : "completed",
  }));
  pi.on("ui_prompt_start", () => broadcast(textUpdate("\n[Pi is waiting for your response in the terminal.]\n")));
  pi.on("agent_settled", (event) => {
    if (pending?.phase === "running") finish(event.aborted ? "cancelled" : "end_turn", pending.error);
  });
  pi.on("session_tree", async () => {
    for (const peer of peers) peer.connection.close(new Error("Pi changed conversation branch. Reattach to refresh history."));
  });
  pi.on("session_shutdown", async () => {
    context.ui.setStatus("zed-pi-live", undefined);
    await close();
  });
}

export default function (pi: ExtensionAPI): void {
  installBridge(pi);
}
