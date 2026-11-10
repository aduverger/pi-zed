#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { createAdapter } from "./adapter.js";
import { MAX_MESSAGE_BYTES } from "./transport.js";

const connection = createAdapter().connect(acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
  { maxMessageBytes: MAX_MESSAGE_BYTES },
));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => connection.close());
}
await connection.closed;
