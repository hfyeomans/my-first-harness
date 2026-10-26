import { validateToolArguments, type JsonObject, type TSchema } from "@earendil-works/pi-ai";

export function parseArguments<A>(name: string, description: string, parameters: TSchema, args: unknown): A {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${name} arguments must be an object.`);
  }
  return validateToolArguments(
    { name, description, parameters },
    {
      type: "toolCall",
      id: "parse",
      name,
      arguments: args as JsonObject,
    },
  ) as A;
}
