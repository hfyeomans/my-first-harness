import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { toolCallsOf, toolResultMessage } from "./messages.js";
import { findTool } from "./registry.js";
import type { AgentModel, Tool, ToolContext, ToolResult } from "./types.js";

/** Model calls before the loop stops. Each call's tool calls still run. */
export const DEFAULT_MAX_TURNS = 8;

export interface RunAgentOptions {
  model: AgentModel;
  maxTurns?: number;
  cwd?: string;
  /** Called with each tool call before that tool runs. */
  onToolCall?: (call: ToolCall) => void;
}

/**
 * Send `history` to the model, run any tool calls, append the results, and
 * repeat until the model answers with no tool calls.
 *
 * Returns a new array: the original messages plus everything this run appended.
 * The caller's array is left as it was.
 */
export async function runAgent(
  history: Message[],
  tools: readonly Tool<any>[],
  options: RunAgentOptions,
): Promise<Message[]> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error(`maxTurns must be a positive integer, got ${String(maxTurns)}.`);
  }

  const ctx: ToolContext = { cwd: options.cwd ?? process.cwd() };
  const messages = history.slice();

  for (let turn = 0; turn < maxTurns; turn++) {
    const assistant = await options.model.complete(messages, tools);
    messages.push(assistant);
    const calls = toolCallsOf(assistant);
    if (calls.length === 0) return messages;

    for (const call of calls) {
      options.onToolCall?.(call);
      const result = await executeTool(call, tools, ctx);
      messages.push(toolResultMessage(call, result));
    }
  }

  // The cap counts model calls. Results from the last call stay in the transcript,
  // and the model is not asked again.
  return messages;
}

async function executeTool(
  call: ToolCall,
  tools: readonly Tool<any>[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = findTool(tools, call.name);
  if (!tool) return { ok: false, error: `Unknown tool: ${call.name}` };

  try {
    const args = tool.parse(call.arguments);
    return await tool.run(args, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
