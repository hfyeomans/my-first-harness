import type { AssistantMessage, Message, Model, Models } from "@earendil-works/pi-ai";
import type { AgentModel, Tool } from "./types.js";

const SYSTEM_PROMPT =
  "You are a coding agent. To inspect a file, call read_file with a path relative to the working directory. When you have what you need, answer in plain text and stop calling tools.";

/** Adapt pi-ai's `Models.complete` to the loop's `AgentModel`. */
export function piModel(models: Models, model: Model<any>): AgentModel {
  return {
    async complete(history: readonly Message[], tools: readonly Tool<any>[]): Promise<AssistantMessage> {
      const assistant = await models.complete(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [...history],
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      });
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        throw new Error(assistant.errorMessage || `Model stopped (${assistant.stopReason}).`);
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
