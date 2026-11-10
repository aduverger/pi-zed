import * as acp from "@agentclientprotocol/sdk";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function promptText(blocks: acp.ContentBlock[]): string {
  const text = blocks.map((block) => {
    switch (block.type) {
      case "text": return block.text;
      case "resource":
        if ("text" in block.resource) return `Context (${block.resource.uri}):\n${block.resource.text}`;
        break;
      case "resource_link": return `Referenced resource: ${block.uri}`;
    }
    throw acp.RequestError.invalidParams(undefined, "Only text and embedded text resources are supported");
  }).join("\n\n");
  if (!text.trim()) throw acp.RequestError.invalidParams(undefined, "Prompt is empty");
  return text;
}

export function textUpdate(text: string, role: "user" | "assistant" = "assistant"): acp.SessionUpdate {
  return {
    sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
    content: { type: "text", text },
  };
}

export function historyUpdates(entries: SessionEntry[]): acp.SessionUpdate[] {
  const updates: acp.SessionUpdate[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user" || message.role === "assistant") {
      const blocks = typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
      for (const block of blocks) {
        if (block.type === "text" && "text" in block) updates.push(textUpdate(String(block.text), message.role));
        if (block.type === "toolCall" && "id" in block && "name" in block) {
          updates.push({ sessionUpdate: "tool_call", toolCallId: String(block.id), title: String(block.name), status: "pending" });
        }
      }
    } else if (message.role === "toolResult") {
      updates.push({
        sessionUpdate: "tool_call_update", toolCallId: message.toolCallId,
        status: message.isError ? "failed" : "completed",
        content: message.content.filter((block) => block.type === "text").map((block) => ({
          type: "content", content: { type: "text", text: block.text },
        })),
      });
    }
  }
  return updates;
}
