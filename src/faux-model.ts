import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentModel } from "./types.js";

// The offline demo is not an LLM. It reads the first filename in the prompt
// so `myagent --provider faux` can exercise the loop without an API key.
const FILENAME =
  /(?:^|[\s"'`(])((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:txt|md|json|ts|tsx|js|jsx|mjs|cjs|css|html|yml|yaml|toml|py|go|rs|lock))(?=$|[\s"'`).,!?;:])/i;

export function createFauxModel(): AgentModel {
  let turns = 0;
  return {
    async complete(history: readonly Message[]): Promise<AssistantMessage> {
      turns += 1;
      if (turns === 1) return firstTurn(history);
      return answerFromToolResult(history);
    },
  };
}

function firstTurn(history: readonly Message[]): AssistantMessage {
  const prompt = firstUserText(history);
  const file = prompt ? filenameIn(prompt) : undefined;
  if (!file) {
    return fauxAssistantMessage("Name a file to read, for example: Read sample.txt");
  }
  return fauxAssistantMessage([fauxToolCall("read_file", { path: file }, { id: "faux-1" })], {
    stopReason: "toolUse",
  });
}

function answerFromToolResult(history: readonly Message[]): AssistantMessage {
  let result: Extract<Message, { role: "toolResult" }> | undefined;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.role === "toolResult") {
      result = message;
      break;
    }
  }
  if (!result) return fauxAssistantMessage("I did not get a tool result.");

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

function textOf(message: Extract<Message, { role: "toolResult" }>): string {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}
