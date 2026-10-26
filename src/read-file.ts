import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Type, validateToolArguments, type JsonObject, type Static } from "@earendil-works/pi-ai";
import type { Tool, ToolResult } from "./types.js";

const MAX_BYTES = 200_000;

const DESCRIPTION =
  "Read a UTF-8 text file. The path is relative to the working directory and must stay inside it. Refuses directories, files that are not valid UTF-8, files that contain a NUL byte, and files larger than 200000 bytes.";

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

  // Remember the real cwd before opening. A later rename of a parent directory
  // must not move the boundary we compare against.
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (err) {
    if (isEnoent(err)) return { ok: false, error: `No such file: ${rel}` };
    return { ok: false, error: errorText(err) };
  }

  let fh: FileHandle;
  try {
    fh = await open(full, "r");
  } catch (err) {
    if (isEnoent(err)) return { ok: false, error: `No such file: ${rel}` };
    if (isEisdir(err)) return { ok: false, error: `${rel} is not a file.` };
    return { ok: false, error: errorText(err) };
  }

  try {
    // Check the descriptor we opened, then read that same descriptor. realpath()
    // on the path and a later readFile() are two lookups: a directory swapped
    // for a symlink in between would be read from outside cwd.
    const opened = await locationOf(fh, full);
    if (escapes(realRoot, opened)) {
      return { ok: false, error: "Path escapes the working directory." };
    }

    const info = await fh.stat();
    if (!info.isFile()) return { ok: false, error: `${rel} is not a file.` };
    if (info.size > MAX_BYTES) {
      return { ok: false, error: `${rel} is too large to read (${info.size} bytes).` };
    }

    const bytes = await fh.readFile();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, error: `${rel} is not valid UTF-8.` };
    }
    if (text.includes("\0")) return { ok: false, error: `${rel} contains a NUL byte.` };
    return { ok: true, output: text };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  } finally {
    await fh.close();
  }
}

/** Canonical path of an open file. On Linux this follows the descriptor, not the name. */
async function locationOf(fh: FileHandle, fallback: string): Promise<string> {
  if (process.platform === "linux") return realpath(`/proc/self/fd/${fh.fd}`);
  return realpath(fallback);
}

function escapes(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isEnoent(err: unknown): boolean {
  return codeIs(err, "ENOENT");
}

function isEisdir(err: unknown): boolean {
  return codeIs(err, "EISDIR");
}

function codeIs(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
