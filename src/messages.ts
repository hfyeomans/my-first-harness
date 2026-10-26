import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ToolResult } from "./types.js";

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
