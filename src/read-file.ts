import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Type, validateToolArguments, type JsonObject, type Static } from "@earendil-works/pi-ai";
import type { Tool, ToolResult } from "./types.js";

const MAX_BYTES = 200_000;

const DESCRIPTION =
  "Read a UTF-8 text file. The path is relative to the working directory and must stay inside it. Refuses directories, binary files, and files larger than 200000 bytes.";

const parameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Path relative to the working directory",
    }),
  },
  { additionalProperties: false },
);

type ReadFileArgs = Static<typeof parameters>;

export const readFileTool: Tool<ReadFileArgs> = {
  name: "read_file",
  description: DESCRIPTION,
  parameters,
  parse(args: unknown): ReadFileArgs {
    const validated: unknown = validateToolArguments(
      { name: "read_file", description: DESCRIPTION, parameters },
      {
        type: "toolCall",
        id: "parse",
        name: "read_file",
        arguments: asObject(args),
      },
    );
    if (!isReadFileArgs(validated)) {
      throw new Error("read_file requires a string path.");
    }
    return validated;
  },
  run(args, ctx) {
    return readFileAt(args.path, ctx.cwd);
  },
};

function asObject(args: unknown): JsonObject {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("read_file arguments must be an object.");
  }
  return args as JsonObject;
}

function isReadFileArgs(value: unknown): value is ReadFileArgs {
  return (
    value !== null &&
    typeof value === "object" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

async function readFileAt(rel: string, cwd: string): Promise<ToolResult> {
  if (rel.trim() === "") return { ok: false, error: "Path is empty." };
  if (path.isAbsolute(rel)) {
    return { ok: false, error: "Path must be relative to the working directory." };
  }

  const root = path.resolve(cwd);
  const full = path.resolve(root, rel);
  // `a/../b` stays inside cwd. A path that resolves outside it does not.
  if (escapes(root, full)) {
    return { ok: false, error: "Path escapes the working directory." };
  }

  // realpath catches a symlink that lives inside cwd but points outside it.
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(root);
    realFile = await realpath(full);
  } catch (err) {
    if (isEnoent(err)) return { ok: false, error: `No such file: ${rel}` };
    return { ok: false, error: errorText(err) };
  }
  if (escapes(realRoot, realFile)) {
    return { ok: false, error: "Path escapes the working directory." };
  }

  let info: Stats;
  try {
    info = await stat(realFile);
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  if (!info.isFile()) return { ok: false, error: `${rel} is not a file.` };
  if (info.size > MAX_BYTES) {
    return { ok: false, error: `${rel} is too large to read (${info.size} bytes).` };
  }

  let text: string;
  try {
    text = await readFile(realFile, "utf8");
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
  if (text.includes("\0")) return { ok: false, error: `${rel} is not a UTF-8 text file.` };
  return { ok: true, output: text };
}

function escapes(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
