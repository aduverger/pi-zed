import * as acp from "@agentclientprotocol/sdk";

export const REVIEW_META_KEY = "zed-pi-live/review";

export type ReviewRequest = {
  version: 1;
  threadId: string;
  submissionId: string;
};

export function reviewRequest(blocks: acp.ContentBlock[]): ReviewRequest | undefined {
  let request: ReviewRequest | undefined;
  for (const block of blocks) {
    const value = block._meta?.[REVIEW_META_KEY];
    if (value === undefined) continue;
    if (request || block.type !== "text" || !value || typeof value !== "object") {
      throw acp.RequestError.invalidParams(undefined, "Expected one text block with review metadata");
    }
    const candidate = value as Record<string, unknown>;
    const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(id);
    if (candidate.version !== 1 || !validId(candidate.threadId) || !validId(candidate.submissionId)) {
      throw acp.RequestError.invalidParams(undefined, "Unsupported or malformed inline review metadata");
    }
    request = { version: 1, threadId: candidate.threadId, submissionId: candidate.submissionId };
  }
  return request;
}
