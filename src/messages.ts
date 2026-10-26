import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolResult } from "./types.js";

export type ReplyCheck = { ok: true } | { ok: false; overflow: boolean; error: string };

/**
 * Overflow is checked first because a zero-output `length` stop can be an
 * overflow, and the `length` rule would hide it. Pass the real window, or that
 * case and silent overflow go undetected.
 */
export function classifyReply(message: AssistantMessage, contextWindow: number | undefined): ReplyCheck {
  if (isContextOverflow(message, contextWindow)) {
    return { ok: false, overflow: true, error: "The conversation does not fit in the model's context window." };
  }
  if (message.stopReason === "stop" || message.stopReason === "toolUse") return { ok: true };
  if (message.stopReason === "length") {
    return { ok: false, overflow: false, error: "The model stopped because it hit its output limit." };
  }
  return {
    ok: false,
    overflow: false,
    error: message.errorMessage || `Model stopped (${message.stopReason}).`,
  };
}

export function toolCallsOf(message: AssistantMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "toolCall") calls.push(block);
  }
  return calls;
}

export function assistantText(message: AssistantMessage): string {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/** The answer, when the latest assistant message asked for no tools. */
export function finalAnswer(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (toolCallsOf(message).length > 0) return undefined;
    return assistantText(message);
  }
  return undefined;
}

/** The one place a `ToolResult` becomes a pi-ai message. */
export function toolResultMessage(call: ToolCall, result: ToolResult): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: result.ok ? result.output : result.error }],
    isError: !result.ok,
    timestamp: Date.now(),
  };
}
