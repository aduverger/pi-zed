import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { privateDirectory } from "./transport.js";

export const REVIEW_STORE_METHOD = "_zed-pi-live/review-store";
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type ReviewOutcome = "pending" | "answered" | "failed" | "cancelled" | "not_sent";
export type SavedReview = {
  version: 1;
  discussionId: string;
  submissionId: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  before: string;
  after: string;
  comment: string;
  createdAt: number;
  outcome: ReviewOutcome;
  reply?: string;
  error?: string;
};

type StoreRequest = { sessionId: string; version: 1 } & (
  | { operation: "list"; path: string }
  | { operation: "create"; review: SavedReview }
  | { operation: "finish"; submissionId: string; outcome: Exclude<ReviewOutcome, "pending">; reply?: string; error?: string }
);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a review-store object");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Expected a review UUID");
  return value;
}
function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new Error("Expected an absolute file path");
  return value;
}
function outcome(value: unknown): ReviewOutcome {
  if (typeof value !== "string" || !["pending", "answered", "failed", "cancelled", "not_sent"].includes(value)) throw new Error("Invalid review outcome");
  return value as ReviewOutcome;
}
function completion(value: Record<string, unknown>): void {
  outcome(value.outcome);
  for (const field of ["reply", "error"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`Invalid ${field}`);
  }
  if ((value.outcome === "answered") !== (typeof value.reply === "string")) throw new Error("Only answered reviews must have a reply");
  if (value.outcome === "pending" && value.error !== undefined) throw new Error("Pending reviews cannot have an error");
}
function savedReview(value: unknown): SavedReview {
  const record = object(value);
  if (record.version !== 1) throw new Error("Unsupported review storage version");
  identifier(record.discussionId);
  identifier(record.submissionId);
  absolutePath(record.path);
  for (const field of ["excerpt", "before", "after", "comment"]) {
    if (typeof record[field] !== "string") throw new Error(`Invalid review ${field}`);
  }
  if (!(record.comment as string).trim()) throw new Error("Review comment is empty");
  if (!Number.isSafeInteger(record.startLine) || !Number.isSafeInteger(record.endLine)
      || Number(record.startLine) < 0 || Number(record.endLine) <= Number(record.startLine)
      || Number(record.endLine) > 0xffff_ffff) throw new Error("Invalid review lines");
  if (!Number.isSafeInteger(record.createdAt) || Number(record.createdAt) < 0) throw new Error("Invalid review timestamp");
  completion(record);
  return record as SavedReview;
}

export function storeRequest(value: unknown): StoreRequest {
  const request = object(value);
  if (request.version !== 1 || typeof request.sessionId !== "string") throw new Error("Unsupported review-store request");
  if (request.operation === "list") absolutePath(request.path);
  else if (request.operation === "create") {
    if (savedReview(request.review).outcome !== "pending") throw new Error("New reviews must be pending");
  } else if (request.operation === "finish") {
    identifier(request.submissionId);
    completion(request);
    if (request.outcome === "pending") throw new Error("Expected a terminal review outcome");
  } else throw new Error("Unknown review-store operation");
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_STORE_BYTES) throw new Error("Review-store request is too large");
  return request as StoreRequest;
}

export function reviewDataDirectory(): string {
  const dataHome = process.env.XDG_DATA_HOME;
  return join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share"), "zed-pi-review");
}

async function readReview(path: string): Promise<SavedReview> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > MAX_STORE_BYTES) {
      throw new Error(`Unsafe or oversized review file: ${path}`);
    }
    return savedReview(JSON.parse(await file.readFile("utf8")));
  } finally { await file.close(); }
}

async function readCurrentReview(path: string): Promise<SavedReview> {
  const original = await readReview(path);
  const completed = await readReview(`${path}.completed`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (!completed) return original;
  const expected = { ...original, outcome: completed.outcome,
    ...(completed.reply !== undefined ? { reply: completed.reply } : {}),
    ...(completed.error !== undefined ? { error: completed.error } : {}) };
  if (original.outcome !== "pending" || completed.outcome === "pending" || !isDeepStrictEqual(expected, completed)) {
    throw new Error(`Completed review does not match its original post: ${path}`);
  }
  return completed;
}

async function publishReview(path: string, record: SavedReview): Promise<void> {
  const text = JSON.stringify(record);
  if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new Error("Review is too large to save");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(text); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function accessReviewStore(cwd: string, request: StoreRequest, root = reviewDataDirectory()): Promise<{ version: 1; reviews?: SavedReview[] }> {
  const project = await realpath(cwd);
  await mkdir(dirname(root), { recursive: true });
  await privateDirectory(root);
  const directory = join(root, createHash("sha256").update(project).digest("hex"));
  await privateDirectory(directory);
  if (request.operation === "list") {
    const reviews: SavedReview[] = [];
    let responseBytes = 2;
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      const id = identifier(name.slice(0, -5));
      const review = await readCurrentReview(join(directory, name));
      if (review.submissionId !== id) throw new Error(`Review ID does not match its file: ${name}`);
      if (review.path === request.path) {
        responseBytes += Buffer.byteLength(JSON.stringify(review)) + 1;
        if (responseBytes > MAX_STORE_BYTES) throw new Error("Saved reviews exceed the response size limit");
        reviews.push(review);
      }
    }
    reviews.sort((a, b) => a.createdAt - b.createdAt || a.submissionId.localeCompare(b.submissionId));
    return { version: 1, reviews };
  }
  if (request.operation === "create") {
    await publishReview(join(directory, `${request.review.submissionId}.json`), request.review);
  } else {
    const path = join(directory, `${request.submissionId}.json`);
    const previous = await readCurrentReview(path);
    if (previous.submissionId !== request.submissionId) throw new Error("Review ID does not match its file");
    if (previous.outcome !== "pending") throw new Error("This review already has a terminal outcome; nothing was overwritten");
    const next = { ...previous, outcome: request.outcome, ...(request.reply !== undefined ? { reply: request.reply } : {}), ...(request.error !== undefined ? { error: request.error } : {}) };
    await publishReview(`${path}.completed`, next);
  }
  return { version: 1 };
}
