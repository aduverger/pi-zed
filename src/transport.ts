import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const ENDPOINT_ID = /^[a-f0-9]{32}$/;

export function runtimeDirectory(): string {
  if (!process.getuid) throw new Error("Live attachment requires macOS or Linux");
  return join(tmpdir(), `zed-pi-live-${process.getuid()}`);
}

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe bridge directory (expected owned directory, mode 0700): ${directory}`);
  }
}

export function socketPath(directory: string, id: string): string {
  if (!ENDPOINT_ID.test(id)) throw new Error("Invalid live session ID");
  const path = join(directory, `${id}.sock`);
  if (Buffer.byteLength(path) > 103) throw new Error(`Unix socket path is too long: ${path}`);
  return path;
}

export async function secureSocket(path: string): Promise<void> {
  await chmod(path, 0o600);
}

export function socketStream(socket: Socket): acp.Stream {
  return acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket), {
    maxMessageBytes: MAX_MESSAGE_BYTES,
  });
}

export const initialization: acp.InitializeResponse = {
  protocolVersion: acp.PROTOCOL_VERSION,
  agentInfo: { name: "zed-pi-live", version: "0.1.0" },
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { list: {} },
    promptCapabilities: { embeddedContext: true },
  },
  authMethods: [],
};

export async function connectSession(
  directory: string,
  id: string,
  onUpdate: (notification: acp.SessionNotification) => void | Promise<void> = () => {},
): Promise<acp.ClientConnection> {
  await privateDirectory(directory);
  const path = socketPath(directory, id);
  const stat = await lstat(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe bridge socket: ${path}`);
  }
  const socket = createConnection(path);
  socket.on("error", () => {});
  const deadline = setTimeout(() => socket.destroy(new Error("Live session connection timed out")), 3000);
  let connection: acp.ClientConnection | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    connection = acp.client({ name: "zed-pi-live-adapter" })
      .onNotification(acp.methods.client.session.update, ({ params }) => onUpdate(params))
      .connect(socketStream(socket));
    void connection.closed.then(() => socket.destroy());
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "zed-pi-live-adapter", version: "0.1.0" },
    }, { cancellationSignal: AbortSignal.timeout(3000), stopWaitingOnCancel: true });
    return connection;
  } catch (error) {
    connection?.close();
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

export async function discoverSessions(directory: string, cwd?: string | null): Promise<acp.SessionInfo[]> {
  await privateDirectory(directory);
  const sessions: acp.SessionInfo[] = [];
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".sock") || !ENDPOINT_ID.test(name.slice(0, -5))) continue;
    let connection: acp.ClientConnection | undefined;
    try {
      connection = await connectSession(directory, name.slice(0, -5));
      const result = await connection.agent.request(acp.methods.agent.session.list, { cwd }, {
        cancellationSignal: AbortSignal.timeout(3000), stopWaitingOnCancel: true,
      });
      sessions.push(...result.sessions);
    } catch {
      // Dead processes leave socket files; never delete an endpoint owned by another process.
    } finally {
      connection?.close();
    }
  }
  return sessions.sort((a, b) => (a.title ?? a.sessionId).localeCompare(b.title ?? b.sessionId));
}
