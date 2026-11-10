import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { accessReviewStore, REVIEW_STORE_METHOD, storeRequest, type SavedReview } from "../src/review-store.js";
import { createAdapter } from "../src/adapter.js";

function review(path: string): SavedReview {
  return { version: 1, discussionId: randomUUID(), submissionId: randomUUID(), path, startLine: 0,
    endLine: 1, excerpt: "original code", before: "", after: "", comment: "Why?", createdAt: Date.now() * 1000, outcome: "pending" };
}
function request(params: Record<string, unknown>) { return storeRequest({ sessionId: "session", version: 1, ...params }); }

test("review store survives reopening, isolates projects, and never overwrites terminal replies", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-review-store-"));
  try {
    const root = join(temporary, "data");
    const project = join(temporary, "project");
    await mkdir(project);
    const saved = review(join(project, "file.txt"));
    await accessReviewStore(project, request({ operation: "create", review: saved }), root);
    const alias = join(temporary, "alias");
    await symlink(project, alias);
    assert.deepEqual((await accessReviewStore(alias, request({ operation: "list", path: saved.path }), root)).reviews, [saved]);
    assert.deepEqual((await accessReviewStore(temporary, request({ operation: "list", path: saved.path }), root)).reviews, []);
    await accessReviewStore(project, request({ operation: "finish", submissionId: saved.submissionId, outcome: "answered", reply: "**Pi reply**" }), root);
    const reopened = await accessReviewStore(project, request({ operation: "list", path: saved.path }), root);
    assert.deepEqual(reopened.reviews, [{ ...saved, outcome: "answered", reply: "**Pi reply**" }]);
    await assert.rejects(accessReviewStore(project, request({ operation: "create", review: saved }), root), /EEXIST/);
    await assert.rejects(accessReviewStore(project, request({ operation: "finish", submissionId: saved.submissionId, outcome: "cancelled" }), root), /terminal outcome/);
    assert.deepEqual(await accessReviewStore(project, request({ operation: "list", path: saved.path }), root), reopened);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("concurrent comments in the same discussion remain separate records", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-review-store-"));
  try {
    const root = join(temporary, "data");
    const first = review(join(temporary, "file.txt"));
    const second = { ...first, submissionId: randomUUID(), comment: "Follow-up", createdAt: first.createdAt + 1 };
    await Promise.all([first, second].map((record) => accessReviewStore(temporary, request({ operation: "create", review: record }), root)));
    assert.deepEqual((await accessReviewStore(temporary, request({ operation: "list", path: first.path }), root)).reviews, [first, second]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("concurrent completions cannot replace another client's outcome", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-review-store-"));
  try {
    const root = join(temporary, "data");
    const saved = review(join(temporary, "file.txt"));
    await accessReviewStore(temporary, request({ operation: "create", review: saved }), root);
    const replies = ["First answer", "Second answer"];
    const attempts = await Promise.allSettled(replies.map((reply) => accessReviewStore(temporary,
      request({ operation: "finish", submissionId: saved.submissionId, outcome: "answered", reply }), root)));
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const winner = attempts.findIndex((attempt) => attempt.status === "fulfilled");
    const restored = await accessReviewStore(temporary, request({ operation: "list", path: saved.path }), root);
    assert.equal(restored.reviews?.[0]?.reply, replies[winner]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("unsafe files, corruption, unsupported versions, and path traversal fail visibly", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-review-store-"));
  try {
    const root = join(temporary, "data");
    const saved = review(join(temporary, "file.txt"));
    await accessReviewStore(temporary, request({ operation: "create", review: saved }), root);
    const [project] = await readdir(root);
    const file = join(root, project!, `${saved.submissionId}.json`);
    const list = request({ operation: "list", path: saved.path });
    await chmod(file, 0o644);
    await assert.rejects(accessReviewStore(temporary, list, root), /Unsafe/);
    await chmod(file, 0o600);
    await writeFile(file, "broken JSON");
    await assert.rejects(accessReviewStore(temporary, list, root), /JSON/);
    await rm(file);
    const other = join(temporary, "other.json");
    await writeFile(other, JSON.stringify(saved), { mode: 0o600 });
    await symlink(other, file);
    await assert.rejects(accessReviewStore(temporary, list, root), /ELOOP/);
    assert.equal(await readFile(other, "utf8"), JSON.stringify(saved));
    assert.throws(() => request({ operation: "create", review: { ...saved, submissionId: "../escape" } }), /UUID/);
    assert.throws(() => storeRequest({ version: 2, sessionId: "s", operation: "list", path: saved.path }), /version|request/);
    assert.throws(() => request({ operation: "finish", submissionId: saved.submissionId, outcome: "answered" }), /reply/);
    assert.throws(() => request({ operation: "finish", submissionId: saved.submissionId, outcome: ["cancelled"] }), /outcome/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("CLI process restart restores user-level data without creating project files", { timeout: 15_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-review-cli-"));
  const project = join(temporary, "project");
  await mkdir(project);
  const saved = review(join(project, "file.txt"));
  const clients: acp.ClientConnection[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  try {
    for (const operation of ["create", "list"] as const) {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url))], {
        env: { ...process.env, TMPDIR: temporary, XDG_DATA_HOME: join(temporary, "data") },
        stdio: ["pipe", "pipe", "inherit"],
      });
      children.push(child);
      const exited = once(child, "exit");
      const client = acp.client({ name: "storage-restart-test" })
        .onNotification(acp.methods.client.session.update, () => {})
        .connect(acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!)));
      clients.push(client);
      const options = { cancellationSignal: AbortSignal.timeout(5000), stopWaitingOnCancel: true };
      await client.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }, options);
      const { sessionId } = await client.agent.request(acp.methods.agent.session.new, { cwd: project, mcpServers: [] }, options);
      const result = await client.agent.request(REVIEW_STORE_METHOD, { version: 1, sessionId, operation,
        ...(operation === "create" ? { review: saved } : { path: saved.path }) }, options);
      assert.deepEqual(result, operation === "create" ? { version: 1 } : { version: 1, reviews: [saved] });
      client.close();
      child.stdin!.end();
      const [code] = await exited;
      assert.equal(code, 0);
    }
    assert.deepEqual(await readdir(project), []);
    assert.deepEqual(await readdir(join(temporary, "data")), ["zed-pi-review"]);
  } finally {
    for (const client of clients) client.close();
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ACP storage operates without a pi process or model prompt and rejects unknown sessions", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-review-store-"));
  const clientToAgent = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
  const agentToClient = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
  const agent = createAdapter(join(temporary, "sockets"), join(temporary, "data")).connect({ readable: clientToAgent.readable, writable: agentToClient.writable });
  const client = acp.client({ name: "test" }).onNotification(acp.methods.client.session.update, () => {}).connect({ readable: agentToClient.readable, writable: clientToAgent.writable });
  try {
    await client.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await client.agent.request(acp.methods.agent.session.new, { cwd: temporary, mcpServers: [] });
    const saved = review(join(temporary, "file.txt"));
    const send = (params: Record<string, unknown>) => client.agent.request(REVIEW_STORE_METHOD, { sessionId: session.sessionId, version: 1, ...params });
    assert.deepEqual(await send({ operation: "create", review: saved }), { version: 1 });
    assert.deepEqual(await send({ operation: "list", path: saved.path }), { version: 1, reviews: [saved] });
    await assert.rejects(send({ operation: "list", path: saved.path, sessionId: "unknown" }));
  } finally {
    client.close(); agent.close();
    await Promise.all([client.closed, agent.closed]);
    await rm(temporary, { recursive: true, force: true });
  }
});
