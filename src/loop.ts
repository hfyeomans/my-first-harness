import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { compact } from "./compaction.js";
import { classifyReply, toolCallsOf, toolResultMessage } from "./messages.js";
import { findTool } from "./registry.js";
import { memorySession, type Session } from "./session.js";
import type { AgentModel, Tool, ToolContext, ToolResult } from "./types.js";

/** Accepted model replies before the loop stops. Each reply's tool calls still run. */
export const DEFAULT_MAX_TURNS = 8;

export interface RunAgentOptions {
  model: AgentModel;
  maxTurns?: number;
  cwd?: string;
  /** Called with each tool call before that tool runs. */
  onToolCall?: (call: ToolCall) => void;
  /** Where the conversation lives. Default: an empty session that writes nothing. */
  session?: Session;
}

/**
 * Append `history` to the session, send the model what the session holds, run
 * any tool calls, append the results, and repeat until the model answers with
 * no tool calls.
 *
 * A turn is one accepted reply. Summary calls and a reply refused as too long
 * do not use a turn. Every message reaches the session before the next step.
 *
 * Returns what the model would see next. After a compaction that starts with
 * the summary. The caller's array is left as it was.
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
  const session = options.session ?? memorySession();
  for (const message of history) await session.appendMessage(message);

  for (let turn = 0; turn < maxTurns; turn++) {
    const assistant = await nextReply(session, options.model, tools);
    await session.appendMessage(assistant);
    const calls = toolCallsOf(assistant);
    if (calls.length === 0) break;

    for (const call of calls) {
      options.onToolCall?.(call);
      const result = await executeTool(call, tools, ctx);
      await session.appendMessage(toolResultMessage(call, result));
    }
  }
  return session.messages();
}

async function nextReply(session: Session, model: AgentModel, tools: readonly Tool<any>[]): Promise<AssistantMessage> {
  const context = model.context;
  if (context) await compact(session, context, "threshold");

  const first = await model.complete(session.messages(), tools);
  const check = classifyReply(first, context?.window);
  if (check.ok) return first;
  if (!check.overflow || !context || !(await compact(session, context, "overflow"))) {
    throw new Error(check.error);
  }

  const second = await model.complete(session.messages(), tools);
  const retry = classifyReply(second, context.window);
  if (!retry.ok) throw new Error(retry.error);
  return second;
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
