import { contentText, type Message, type Model, type Models } from "@earendil-works/pi-ai";
import { snapshotSection } from "./memory.js";
import { assistantText, classifyReply } from "./messages.js";
import { toolDeclarations } from "./registry.js";
import type { AgentModel, SummaryInput } from "./types.js";

const SYSTEM_PROMPT = [
  "You are a coding agent.",
  "Paths for read_file, write_file, and edit_file are relative to the working directory and must stay inside it.",
  "Use read_file to inspect a UTF-8 file, write_file to create or overwrite one, and edit_file to replace an exact old_string with new_string.",
  "edit_file does not change the file when old_string is missing or appears more than once. Call it again with more surrounding text so the match is unique.",
  "bash runs a command with the user's permissions, starting in the working directory, and returns the exit code, stdout, and stderr. A non-zero exit is a result, not a tool failure.",
  "remember appends one line to the project's memory, which later runs see in the snapshot below.",
  "When you have what you need, answer in plain text and stop calling tools.",
].join(" ");

const SUMMARY_SYSTEM_PROMPT = [
  "You summarize the earlier part of a coding agent's conversation so the agent can continue with less context.",
  "Keep the user's requests word for word.",
  "List the files read or changed and the commands run, with their outcomes.",
  "Say what is left to do.",
  "Do not call tools. Answer with the summary only.",
].join(" ");

/**
 * Adapt pi-ai's `Models.complete` to the loop's `AgentModel`.
 * `memory` is the snapshot taken when the run started. It is baked into the
 * system prompt here, so a `remember` during the run does not change it.
 */
export function piModel(models: Models, model: Model<any>, memory = ""): AgentModel {
  const systemPrompt = `${SYSTEM_PROMPT} ${snapshotSection(memory)}`;
  return {
    complete(history, tools) {
      return models.complete(model, {
        systemPrompt,
        messages: [...history],
        tools: toolDeclarations(tools),
      });
    },
    context: {
      window: model.contextWindow,
      async summarize(input) {
        const reply = await models.complete(model, {
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: summaryPrompt(input), timestamp: Date.now() }],
        });
        const check = classifyReply(reply, model.contextWindow);
        if (!check.ok) throw new Error(`Compaction failed. ${check.error}`);
        const summary = assistantText(reply).trim();
        if (summary === "") throw new Error("Compaction failed. The summary was empty.");
        return summary;
      },
    },
  };
}

function summaryPrompt({ previous, replaced }: SummaryInput): string {
  const lines = previous === undefined ? [] : ["Summary so far:", previous, ""];
  lines.push("Messages to fold into the summary:");
  for (const message of replaced) lines.push(transcriptLine(message));
  return lines.join("\n");
}

function transcriptLine(message: Message): string {
  switch (message.role) {
    case "system":
    case "user":
      return `[${message.role}] ${contentText(message.content)}`;
    case "assistant":
      return message.content
        .flatMap((block) => {
          if (block.type === "text") return [`[assistant] ${block.text}`];
          if (block.type === "toolCall") return [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`];
          return [];
        })
        .join("\n");
    case "toolResult":
      return `[tool ${message.isError ? "error" : "result"} ${message.toolName}] ${contentText(message.content)}`;
  }
}

export async function loadPiModel(provider: string, modelId: string, memory = ""): Promise<AgentModel> {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const models = builtinModels();
  const found = models.getModel(provider, modelId);
  if (!found) {
    throw new Error(`Unknown model "${modelId}" for provider "${provider}".`);
  }
  return piModel(models, found, memory);
}
