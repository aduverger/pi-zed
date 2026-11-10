import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAdapter } from "../src/adapter.js";
import { installBridge } from "../src/extension.js";
import { discoverSessions, privateDirectory, socketPath } from "../src/transport.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error("Condition did not become true");
}

async function fixture(t: TestContext) {
  const root = await mkdtemp("/tmp/zpl-test-");
  const directory = join(root, "sockets");
  const sessionManager = SessionManager.inMemory(root);
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const submissions: string[] = [];
  let idle = true;
  let aborts = 0;
  const context = {
    cwd: root, sessionManager, model: { id: "fixture", provider: "fixture" },
    isIdle: () => idle, hasPendingMessages: () => false,
    abort: () => { aborts++; },
    ui: { setStatus: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, [...handlers.get(name) ?? [], handler]);
      return () => {};
    },
    sendUserMessage: (text: string) => submissions.push(text),
  } as unknown as ExtensionAPI;
  const emit = async (type: string, fields: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...fields }, context);
  };
  installBridge(pi, directory);
  await emit("session_start");
  const updates: acp.SessionNotification[] = [];
  const connection = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params);
  }).connect(createAdapter(directory));
  await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
  const sessions = (await connection.agent.request(acp.methods.agent.session.list, { cwd: root })).sessions;
  const id = sessions[0]!.sessionId;
  t.after(async () => {
    connection.close();
    await emit("session_shutdown");
    await rm(root, { recursive: true, force: true });
  });
  const attach = () => connection.agent.request(acp.methods.agent.session.load, { sessionId: id, cwd: root, mcpServers: [] });
  const prompt = (text: string, sessionId = id) => connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId, prompt: [{ type: "text", text }],
  });
  async function start(text = submissions.at(-1)!) {
    idle = false;
    await emit("before_agent_start", { messageType: "user", prompt: text });
    const message = { role: "user" as const, content: text, timestamp: Date.now() };
    sessionManager.appendMessage(message);
    await emit("message_start", { message });
  }
  async function reply(text = "answer", error?: string) {
    await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: text } });
    await emit("message_end", { message: { role: "assistant", stopReason: error ? "error" : "stop", errorMessage: error } });
  }
  async function settle(aborted = false) {
    idle = true;
    await emit("agent_settled", { aborted });
  }
  return { root, directory, id, attach, prompt, connection, submissions, updates, emit, start, reply, settle,
    sessionManager, setIdle: (value: boolean) => { idle = value; }, aborts: () => aborts };
}

test("real socket discovery, explicit attachment, streaming and terminal continuation", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(socketPath(f.directory, f.id))).mode & 0o777, 0o600);
  await f.attach();
  const response = f.prompt("Remember emerald-73");
  await until(() => f.submissions.length === 1);
  assert.match(f.submissions[0]!, /Remember emerald-73/);
  await f.start();
  await f.reply("Remembered emerald-73");
  await f.settle();
  assert.equal((await response).stopReason, "end_turn");
  assert(f.updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text.includes("Remembered")));
  assert(!f.updates.some(({ update }) => update.sessionUpdate === "user_message_chunk"));
  await f.start("What did I ask you to remember?");
  await f.reply("emerald-73");
  await f.settle();
  await until(() => f.updates.some(({ update }) => update.sessionUpdate === "user_message_chunk"));
  assert.equal(f.sessionManager.getBranch().filter((entry) => entry.type === "message").length, 2);
});

test("new thread never spawns/selects an agent and supports /attach", async (t) => {
  const f = await fixture(t);
  const { sessionId } = await f.connection.agent.request(acp.methods.agent.session.new, { cwd: f.root, mcpServers: [] });
  await f.prompt("hello", sessionId);
  assert.equal(f.submissions.length, 0);
  await f.prompt(`/attach ${f.id}`, sessionId);
  const response = f.prompt("now attached", sessionId);
  await until(() => f.submissions.length === 1);
  await f.start();
  await f.reply();
  await f.settle();
  await response;
  assert(f.updates.every((update) => update.sessionId === sessionId));
});

test("busy terminal queues a prompt; queued cancellation does not abort terminal", async (t) => {
  const f = await fixture(t);
  await f.attach();
  f.setIdle(false);
  const response = f.prompt("later");
  await until(() => f.updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text.includes("Waiting")));
  assert.equal(f.submissions.length, 0);
  await f.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: f.id });
  assert.equal((await response).stopReason, "cancelled");
  assert.equal(f.aborts(), 0);
  await f.settle();
  await delay(70);
  assert.equal(f.submissions.length, 0);
});

test("queued prompt is submitted once after terminal settles; second prompt rejected", async (t) => {
  const f = await fixture(t);
  await f.attach();
  f.setIdle(false);
  const response = f.prompt("queued");
  await delay(30);
  await assert.rejects(f.prompt("second"), /pending/);
  assert.equal(f.submissions.length, 0);
  await f.settle();
  await until(() => f.submissions.length === 1);
  await f.start();
  await f.reply();
  await f.settle();
  await response;
  await delay(70);
  assert.equal(f.submissions.length, 1);
});

test("active cancellation aborts shared run; provider error surfaces and retry is explicit", async (t) => {
  const f = await fixture(t);
  await f.attach();
  const response = f.prompt("cancel me");
  await until(() => f.submissions.length === 1);
  await f.start();
  await f.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: f.id });
  await until(() => f.aborts() === 1);
  await f.settle(true);
  assert.equal((await response).stopReason, "cancelled");
  const failure = assert.rejects(f.prompt("fail"), /provider unavailable/);
  await until(() => f.submissions.length === 2);
  await f.start();
  await f.reply("", "provider unavailable");
  await f.settle();
  await failure;
  assert.equal(f.submissions.length, 2);
  const retry = f.prompt("retry explicitly");
  await until(() => f.submissions.length === 3);
  await f.start();
  await f.reply();
  await f.settle();
  await retry;
});

test("disconnect does not resend or abort submitted work; reconnect replays live history", async (t) => {
  const f = await fixture(t);
  await f.attach();
  const response = assert.rejects(f.prompt("keep running"));
  await until(() => f.submissions.length === 1);
  await f.start();
  f.connection.close();
  await response;
  await f.reply();
  await f.settle();
  assert.equal(f.aborts(), 0);
  const updates: acp.SessionNotification[] = [];
  const second = acp.client().onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(params); })
    .connect(createAdapter(f.directory));
  t.after(() => second.close());
  await second.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
  await second.agent.request(acp.methods.agent.session.load, { sessionId: f.id, cwd: f.root, mcpServers: [] });
  assert(updates.some(({ update }) => update.sessionUpdate === "user_message_chunk" && update.content.type === "text" && update.content.text.includes("keep running")));
  assert.equal(f.submissions.length, 1);
});

test("reject busy attach, wrong directory, invalid endpoint, unsupported content", async (t) => {
  const f = await fixture(t);
  f.setIdle(false);
  await assert.rejects(f.attach(), /busy/);
  f.setIdle(true);
  await assert.rejects(f.connection.agent.request(acp.methods.agent.session.load, {
    sessionId: f.id, cwd: "/tmp", mcpServers: [],
  }), /different working directory/);
  await assert.rejects(f.connection.agent.request(acp.methods.agent.session.load, {
    sessionId: "../../other", cwd: f.root, mcpServers: [],
  }), /complete live session ID/);
  await f.attach();
  await assert.rejects(f.connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId: f.id, prompt: [{ type: "image", data: "YQ==", mimeType: "image/png" }],
  }), /Only text/);
  assert.equal(f.submissions.length, 0);
});

test("runtime shutdown invalidates attachment and cleans up the endpoint", async (t) => {
  const f = await fixture(t);
  await f.attach();
  await f.emit("session_shutdown");
  await until(() => f.updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text.includes("disconnected")));
  await assert.rejects(f.prompt("do not target a replacement"));
  assert.deepEqual(await discoverSessions(f.directory), []);
});

test("agent_end is not completion while pi may retry; only settled completes the prompt", async (t) => {
  const f = await fixture(t);
  await f.attach();
  let completed = false;
  const response = f.prompt("wait through retry").then((result) => { completed = true; return result; });
  await until(() => f.submissions.length === 1);
  await f.start();
  await f.reply("", "temporary error");
  await f.emit("agent_end", { messages: [] });
  await delay(30);
  assert.equal(completed, false);
  await f.reply("recovered");
  await f.settle();
  assert.equal((await response).stopReason, "end_turn");
});

test("unacknowledged submission fails visibly without resubmission", async (t) => {
  const f = await fixture(t);
  await f.attach();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failed = assert.rejects(f.prompt("input hook consumes this"), /did not acknowledge/);
  for (let i = 0; i < 1000 && f.submissions.length === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.submissions.length, 1);
  t.mock.timers.tick(30_000);
  await failed;
  assert.equal(f.submissions.length, 1);
  t.mock.timers.reset();
});

test("disconnect drops a waiting prompt without touching terminal work", async (t) => {
  const f = await fixture(t);
  await f.attach();
  f.setIdle(false);
  const response = assert.rejects(f.prompt("queued while busy"));
  await until(() => f.updates.some(({ update }) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && update.content.text.includes("Waiting")));
  f.connection.close();
  await response;
  await delay(30);
  await f.settle();
  await delay(70);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.aborts(), 0);
});

test("private directory refuses permissive paths and symlinks; stale endpoints ignored", async (t) => {
  const root = await mkdtemp("/tmp/zpl-security-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "sockets");
  await privateDirectory(directory);
  await chmod(directory, 0o755);
  await assert.rejects(privateDirectory(directory), /Unsafe bridge directory/);
  await chmod(directory, 0o700);
  const link = join(root, "link");
  await symlink(directory, link);
  await assert.rejects(privateDirectory(link), /Unsafe bridge directory/);
  await writeFile(join(directory, `${"a".repeat(32)}.sock`), "not a socket", { mode: 0o600 });
  assert.deepEqual(await discoverSessions(directory), []);
});
