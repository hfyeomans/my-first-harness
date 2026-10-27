import { toToolDeclaration, type Tool as PiTool } from "@earendil-works/pi-ai";
import { bashTool } from "./bash.js";
import { editFileTool } from "./edit-file.js";
import { rememberTool } from "./memory.js";
import { readFileTool } from "./read-file.js";
import type { Tool } from "./types.js";
import { writeFileTool } from "./write-file.js";

// One array is the whole registry. The CLI passes it to the loop, `findTool`
// looks a call up by name, and `toolDeclarations` is what pi-ai is sent.
// A map or a class would not record anything this list does not.
export const agentTools: readonly Tool<any>[] = [readFileTool, writeFileTool, editFileTool, bashTool, rememberTool];

export function findTool(tools: readonly Tool<any>[], name: string): Tool<any> | undefined {
  return tools.find((tool) => tool.name === name);
}

export function toolDeclarations(tools: readonly Tool<any>[]): PiTool[] {
  // `toToolDeclaration` keeps name, description, and parameters, and drops
  // `parse` and `run` (and TypeBox's symbol keys) so the provider sees a schema.
  return tools.map((tool) =>
    toToolDeclaration({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }),
  );
}
