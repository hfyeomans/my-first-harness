import type { AssistantMessage, Message, Model, Models } from "@earendil-works/pi-ai";
import { toolDeclarations } from "./registry.js";
import type { AgentModel, Tool } from "./types.js";

const SYSTEM_PROMPT = [
  "You are a coding agent.",
  "Paths for read_file, write_file, and edit_file are relative to the working directory and must stay inside it.",
  "Use read_file to inspect a UTF-8 file, write_file to create or overwrite one, and edit_file to replace an exact old_string with new_string.",
  "edit_file does not change the file when old_string is missing or appears more than once. Call it again with more surrounding text so the match is unique.",
  "bash runs a command with the user's permissions, starting in the working directory, and returns the exit code, stdout, and stderr. A non-zero exit is a result, not a tool failure.",
  "When you have what you need, answer in plain text and stop calling tools.",
].join(" ");

/** Adapt pi-ai's `Models.complete` to the loop's `AgentModel`. */
export function piModel(models: Models, model: Model<any>): AgentModel {
  return {
    async complete(history: readonly Message[], tools: readonly Tool<any>[]): Promise<AssistantMessage> {
      const assistant = await models.complete(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [...history],
        tools: toolDeclarations(tools),
      });
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        throw new Error(assistant.errorMessage || `Model stopped (${assistant.stopReason}).`);
      }
      // "length" means the provider cut the reply off at its output limit. Text
      // with no tool call would otherwise look like a finished answer.
      if (assistant.stopReason === "length") {
        throw new Error("The model stopped because it hit its output limit.");
      }
      return assistant;
    },
  };
}

export async function loadPiModel(provider: string, modelId: string): Promise<AgentModel> {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const models = builtinModels();
  const found = models.getModel(provider, modelId);
  if (!found) {
    throw new Error(`Unknown model "${modelId}" for provider "${provider}".`);
  }
  return piModel(models, found);
}
