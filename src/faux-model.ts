import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { contentText, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { toolCallsOf } from "./messages.js";
import type { AgentModel, SummaryInput } from "./types.js";

const FILENAME =
  /(?:^|[\s"'`(])((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:txt|md|json|ts|tsx|js|jsx|mjs|cjs|css|html|yml|yaml|toml|py|go|rs|lock))(?=$|[\s"'`).,!?;:])/i;

// A prompt that contains this also edits, then greps, instead of only reading.
const REPLACE = /replace\s+"([^"]*)"\s+with\s+"([^"]*)"/;

export interface FauxOptions {
  /** Tokens. Without it the faux model has no window and the loop never compacts. */
  contextWindow?: number;
}

export function createFauxModel(options: FauxOptions = {}): AgentModel {
  return {
    complete: async (history) => nextStep(history),
    context:
      options.contextWindow === undefined ? undefined : { window: options.contextWindow, summarize: fauxSummary },
  };
}

// Reads only the newest user message and the newest message. Both survive
// resume, and compaction always keeps the newest group, so no step is counted.
function nextStep(history: readonly Message[]): AssistantMessage {
  const users = history.filter((message) => message.role === "user");
  const task = contentText(users.at(-1)?.content ?? "");
  const file = filenameIn(task);
  const last = history.at(-1);

  if (last?.role !== "toolResult") {
    if (file) return toolCall(history, "read_file", { path: file });
    const earlier = users.at(-2);
    if (earlier) return fauxAssistantMessage(`Earlier you asked: ${contentText(earlier.content)}`);
    return fauxAssistantMessage("Name a file to read, for example: Read sample.txt");
  }

  const text = contentText(last.content);
  if (last.isError) {
    return fauxAssistantMessage(
      last.toolName === "read_file" ? `I could not read that file: ${text}` : `Stopped: ${text}`,
    );
  }
  const [, oldString, newString] = task.match(REPLACE) ?? [];
  if (!file || oldString === undefined || newString === undefined) {
    return fauxAssistantMessage(`The file says:\n${text}`);
  }
  if (last.toolName === "read_file") {
    return toolCall(history, "edit_file", { path: file, old_string: oldString, new_string: newString });
  }
  if (last.toolName === "edit_file") {
    return toolCall(history, "bash", { command: `grep -F -n -- ${shellQuote(newString)} ${shellQuote(file)}` });
  }
  return fauxAssistantMessage(`Updated ${file}.\n${text}`);
}

async function fauxSummary({ previous, replaced }: SummaryInput): Promise<string> {
  const request = replaced.findLast((message) => message.role === "user");
  const line = request ? contentText(request.content) : (previous?.split("\n")[0] ?? "");
  const n = replaced.length;
  return `${line}\n(faux summary of ${n} earlier message${n === 1 ? "" : "s"})`;
}

function toolCall(history: readonly Message[], name: string, args: Record<string, string>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args, { id: nextFauxCallId(history) })], { stopReason: "toolUse" });
}

// Counting visible calls repeats a kept id once an earlier call has been summarized away.
function nextFauxCallId(history: readonly Message[]): string {
  let max = 0;
  for (const message of history) {
    if (message.role !== "assistant") continue;
    for (const call of toolCallsOf(message)) {
      const n = Number(/^faux-(\d+)$/.exec(call.id)?.[1]);
      if (n > max) max = n;
    }
  }
  return `faux-${max + 1}`;
}

function filenameIn(prompt: string): string | undefined {
  return prompt.match(FILENAME)?.[1];
}

// Quote for bash -c. A single quote inside ends the quote, inserts \', and reopens it.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
