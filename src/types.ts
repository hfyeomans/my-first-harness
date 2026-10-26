import type { AssistantMessage, Message, TSchema } from "@earendil-works/pi-ai";

export type { AssistantMessage, Message };

/**
 * Outcome of one tool run. `runAgent` turns this into a pi-ai `toolResult`
 * message. A failure is `ok: false` so the model can try again; it is not thrown.
 */
export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

export interface ToolContext {
  /** Working directory. Relative tool paths resolve against this. */
  cwd: string;
}

/**
 * A tool the loop can run.
 *
 * `parameters` is pi-ai's TypeBox schema (the sketch called this field `schema`).
 * `parse` turns the model's raw arguments into `A`, or throws when they are invalid.
 */
export interface Tool<A> {
  name: string;
  description: string;
  parameters: TSchema;
  parse(args: unknown): A;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * One model turn. `piModel` calls pi-ai. Tests pass a script instead.
 * The history uses pi-ai's `Message` so an assistant reply can be sent back
 * unchanged on the next turn (thinking blocks and provider metadata included).
 */
export interface AgentModel {
  complete(history: readonly Message[], tools: readonly Tool<any>[]): Promise<AssistantMessage>;
}
