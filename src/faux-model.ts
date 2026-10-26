import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentModel } from "./types.js";

// The offline demo is not an LLM. It reads the first filename in the prompt
// so `myagent --provider faux` can exercise the loop without an API key.
const FILENAME =
  /(?:^|[\s"'`(])((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:txt|md|json|ts|tsx|js|jsx|mjs|cjs|css|html|yml|yaml|toml|py|go|rs|lock))(?=$|[\s"'`).,!?;:])/i;

// A prompt that contains this also edits, then greps, instead of only reading.
const REPLACE = /replace\s+"([^"]*)"\s+with\s+"([^"]*)"/;

export function createFauxModel(): AgentModel {
  return {
    async complete(history: readonly Message[]): Promise<AssistantMessage> {
      const prompt = firstUserText(history) ?? "";
      const file = filenameIn(prompt);
      if (!file) {
        return fauxAssistantMessage("Name a file to read, for example: Read sample.txt");
      }
      const edit = prompt.match(REPLACE);
      const oldString = edit?.[1];
      const newString = edit?.[2];
      if (oldString === undefined || newString === undefined) return readOnly(history, file);
      return editThenVerify(history, file, oldString, newString);
    },
  };
}

function readOnly(history: readonly Message[], file: string): AssistantMessage {
  const result = lastToolResult(history);
  if (!result) {
    return fauxAssistantMessage([fauxToolCall("read_file", { path: file }, { id: "faux-1" })], {
      stopReason: "toolUse",
    });
  }
  return answerFromToolResult(result);
}

function editThenVerify(
  history: readonly Message[],
  file: string,
  oldString: string,
  newString: string,
): AssistantMessage {
  const results = toolResults(history);
  const last = results.at(-1);
  if (!last) return toolCall("read_file", { path: file }, "faux-1");
  if (last.isError) {
    const text = textOf(last);
    if (results.length === 1) return fauxAssistantMessage(`I could not read that file: ${text}`);
    return fauxAssistantMessage(`Stopped: ${text}`);
  }
  if (results.length === 1) {
    return toolCall(
      "edit_file",
      { path: file, old_string: oldString, new_string: newString },
      "faux-2",
    );
  }
  if (results.length === 2) {
    const command = `grep -F -n -- ${shellQuote(newString)} ${shellQuote(file)}`;
    return toolCall("bash", { command }, "faux-3");
  }
  return fauxAssistantMessage(`Updated ${file}.\n${textOf(last)}`);
}

function toolCall(name: string, args: Record<string, string>, id: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

function answerFromToolResult(result: Extract<Message, { role: "toolResult" }>): AssistantMessage {
  const text = textOf(result);
  if (result.isError) return fauxAssistantMessage(`I could not read that file: ${text}`);
  return fauxAssistantMessage(`The file says:\n${text}`);
}

function firstUserText(history: readonly Message[]): string | undefined {
  for (const message of history) {
    if (message.role !== "user") continue;
    return typeof message.content === "string" ? message.content : undefined;
  }
  return undefined;
}

function filenameIn(prompt: string): string | undefined {
  return prompt.match(FILENAME)?.[1];
}

function toolResults(history: readonly Message[]): Extract<Message, { role: "toolResult" }>[] {
  const results: Extract<Message, { role: "toolResult" }>[] = [];
  for (const message of history) {
    if (message.role === "toolResult") results.push(message);
  }
  return results;
}

function lastToolResult(history: readonly Message[]): Extract<Message, { role: "toolResult" }> | undefined {
  return toolResults(history).at(-1);
}

function textOf(message: Extract<Message, { role: "toolResult" }>): string {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

// Quote for bash -c. A single quote inside ends the quote, inserts \', and reopens it.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
