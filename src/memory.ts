import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import { parseArguments } from "./parse-args.js";
import type { Tool, ToolResult } from "./types.js";

export const MEMORY_DIR = ".myagent";
export const MEMORY_FILE = "MEMORY.md";
/**
 * Bytes of the tail copied into the system prompt. The file on disk is not cut.
 * The tail is the newest notes, because `remember` only appends.
 */
export const MEMORY_SNAPSHOT_BYTES = 8_000;
/**
 * One line stays under PIPE_BUF (4096) even as 4-byte UTF-8, so two writers
 * do not tear a single note.
 */
export const MAX_NOTE_CHARS = 500;

const OMITTED = "[earlier notes omitted]";
const MEMORY_LABEL = `${MEMORY_DIR}/${MEMORY_FILE}`;

export function memoryPath(cwd: string): string {
  return path.join(cwd, MEMORY_DIR, MEMORY_FILE);
}

/**
 * The notes a run puts in its system prompt. Missing file is an empty snapshot.
 * A file longer than `MEMORY_SNAPSHOT_BYTES` contributes its tail, cut on a
 * line, with a marker that older notes were left out.
 */
export async function readMemory(cwd: string): Promise<string> {
  const file = memoryPath(cwd);
  let fh;
  try {
    fh = await open(file, "r");
  } catch (err) {
    if (isNotFound(err)) return "";
    throw err;
  }
  try {
    const info = await fh.stat();
    if (!info.isFile()) throw new Error(`${MEMORY_LABEL} is not a file.`);
    if (info.size === 0) return "";
    if (info.size <= MEMORY_SNAPSHOT_BYTES) return decodeUtf8(await fh.readFile());

    const buf = Buffer.alloc(MEMORY_SNAPSHOT_BYTES);
    await fh.read(buf, 0, MEMORY_SNAPSHOT_BYTES, info.size - MEMORY_SNAPSHOT_BYTES);
    const text = decodeTail(buf);
    const newline = text.indexOf("\n");
    const rest = newline === -1 ? text : text.slice(newline + 1);
    const body = rest.trim() === "" ? text.trimEnd() : rest.trimEnd();
    return `${OMITTED}\n${body}`;
  } finally {
    await fh.close();
  }
}

export function snapshotSection(snapshot: string): string {
  const notes = snapshot.trim() === "" ? "(none)" : snapshot.trimEnd();
  return [
    "Notes remembered from earlier runs were snapshotted at the start of this run and do not change until the next run.",
    "Call remember with one short line for a preference or a correction that later runs should keep.",
    "Do not remember a fact you can read from the project.",
    `Remembered notes:\n${notes}`,
  ].join(" ");
}

const DESCRIPTION = `Append one short line to the project's memory (${MEMORY_DIR}/${MEMORY_FILE} in the working directory). Later runs see it in the system prompt. This run sees it as the tool result. Use it for a preference or a correction that is not in the code. A note is one line of at most ${MAX_NOTE_CHARS} characters.`;

const parameters = Type.Object(
  {
    note: Type.String({
      minLength: 1,
      maxLength: MAX_NOTE_CHARS,
      description: "One line to remember. No line breaks.",
    }),
  },
  { additionalProperties: false },
);

type RememberArgs = Static<typeof parameters>;

export const rememberTool: Tool<RememberArgs> = {
  name: "remember",
  description: DESCRIPTION,
  parameters,
  parse(args: unknown): RememberArgs {
    return parseArguments<RememberArgs>("remember", DESCRIPTION, parameters, args);
  },
  async run(args, ctx): Promise<ToolResult> {
    const note = args.note.trim();
    if (note === "") return { ok: false, error: "A note must not be empty." };
    if (note.includes("\n") || note.includes("\r")) return { ok: false, error: "A note must be one line." };
    try {
      await appendMemory(ctx.cwd, note);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
    return { ok: true, output: `Remembered: ${note}` };
  },
};

async function appendMemory(cwd: string, note: string): Promise<void> {
  const file = memoryPath(cwd);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefix = "";
  try {
    const fh = await open(file, "r");
    try {
      const { size } = await fh.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      }
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await appendFile(file, `${prefix}- ${note}\n`, { mode: 0o600 });
}

function decodeUtf8(bytes: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${MEMORY_LABEL} is not valid UTF-8.`);
  }
  if (text.includes("\0")) throw new Error(`${MEMORY_LABEL} contains a NUL byte.`);
  return text;
}

// A tail read can start on a continuation byte. Skip at most three bytes.
function decodeTail(bytes: Buffer): string {
  const limit = Math.min(4, bytes.length);
  for (let skip = 0; skip < limit; skip++) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(skip));
      if (text.includes("\0")) throw new Error(`${MEMORY_LABEL} contains a NUL byte.`);
      return text;
    } catch (err) {
      if (err instanceof Error && err.message.includes("NUL")) throw err;
    }
  }
  throw new Error(`${MEMORY_LABEL} is not valid UTF-8.`);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
