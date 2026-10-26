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

const CLAUDE_FAMILY = /\b(haiku|sonnet|opus)\b/i;

/**
 * Haiku, Sonnet, and Opus stay on 5.5. An older id is replaced with that
 * provider's 5.5 id before the request. A route with no 5.5 model is refused.
 */
export function resolveCatalogModel(models: Models, provider: string, modelId: string): Model<any> {
  const catalogIds = models.getModels(provider).map((model) => model.id);
  const pinned = pinClaudeModelId(provider, modelId, catalogIds);
  const found = models.getModel(provider, pinned);
  if (!found) {
    throw new Error(`Unknown model "${pinned}" for provider "${provider}".`);
  }
  return found;
}

export async function loadPiModel(provider: string, modelId: string): Promise<AgentModel> {
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  const models = builtinModels();
  return piModel(models, resolveCatalogModel(models, provider, modelId));
}

type ClaudeFamily = "haiku" | "sonnet" | "opus";
type ModelVariant = "batch" | "fast" | "plain";

function pinClaudeModelId(provider: string, modelId: string, catalogIds: readonly string[]): string {
  const located = familyAt(modelId);
  if (!located) return modelId;
  if (isPinned55(modelId, located)) return modelId;

  const pins = catalogIds.filter((id) => {
    const candidate = familyAt(id);
    return candidate?.family === located.family && isPinned55(id, candidate);
  });
  if (pins.length === 0) {
    throw new Error(
      `Claude ${located.family} is pinned to 5.5. Refusing "${modelId}" for provider "${provider}" because that provider has no ${located.family} 5.5 model.`,
    );
  }

  const prefix = modelId.slice(0, located.index).toLowerCase();
  const samePrefix = pins.filter((id) => {
    const candidate = familyAt(id);
    return candidate !== undefined && id.slice(0, candidate.index).toLowerCase() === prefix;
  });
  let pool: readonly string[] | undefined;
  if (samePrefix.length > 0) pool = samePrefix;
  else if (isFloatingAlias(modelId)) pool = pins;
  if (!pool) {
    throw new Error(
      `Claude ${located.family} is pinned to 5.5. Refusing "${modelId}" for provider "${provider}" because that route has no ${located.family} 5.5 model.`,
    );
  }

  const variant = variantOf(modelId);
  const sameVariant = pool.filter((id) => variantOf(id) === variant);
  const plain = pool.filter((id) => variantOf(id) === "plain");
  if (sameVariant.length > 0) return shortest(sameVariant);
  if (plain.length > 0) return shortest(plain);
  return shortest(pool);
}

function familyAt(id: string): { family: ClaudeFamily; index: number } | undefined {
  const match = CLAUDE_FAMILY.exec(id);
  const name = match?.[1]?.toLowerCase();
  if (!match || match.index === undefined || (name !== "haiku" && name !== "sonnet" && name !== "opus")) {
    return undefined;
  }
  return { family: name, index: match.index };
}

function isPinned55(id: string, located: { family: ClaudeFamily; index: number }): boolean {
  const rest = id.slice(located.index + located.family.length);
  return /^[-.]5[-.]5(?!\d)/.test(rest);
}

function isFloatingAlias(id: string): boolean {
  return id.startsWith("~") || /(?:^|[^a-z])latest(?:[^a-z]|$)/i.test(id);
}

function variantOf(id: string): ModelVariant {
  const lower = id.toLowerCase();
  if (/(?:[:/-])batch$/.test(lower)) return "batch";
  if (/(?:[:/-])fast$/.test(lower)) return "fast";
  return "plain";
}

function shortest(ids: readonly string[]): string {
  const first = ids[0];
  if (first === undefined) {
    throw new Error("Claude 5.5 pin had no model to choose.");
  }
  let best = first;
  for (const id of ids) {
    if (id.length < best.length || (id.length === best.length && id < best)) best = id;
  }
  return best;
}
