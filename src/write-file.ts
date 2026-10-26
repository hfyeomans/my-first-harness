import type { FileHandle } from "node:fs/promises";
import { Type, type Static } from "@earendil-works/pi-ai";
import { parseArguments } from "./parse-args.js";
import type { Tool, ToolResult } from "./types.js";
import { MAX_FILE_BYTES, createInside, errorText, openInside } from "./workspace-path.js";

const DESCRIPTION = `Create or overwrite a UTF-8 text file. The path is relative to the working directory and must stay inside it. The parent directory must already exist. Refuses directories, paths that escape the working directory, and contents larger than ${MAX_FILE_BYTES} bytes.`;

const parameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Path relative to the working directory",
    }),
    content: Type.String({ description: "Full new contents of the file" }),
  },
  { additionalProperties: false },
);

type WriteFileArgs = Static<typeof parameters>;

export const writeFileTool: Tool<WriteFileArgs> = {
  name: "write_file",
  description: DESCRIPTION,
  parameters,
  parse(args: unknown): WriteFileArgs {
    return parseArguments<WriteFileArgs>("write_file", DESCRIPTION, parameters, args);
  },
  run(args, ctx) {
    return writeText(args.path, args.content, ctx.cwd);
  },
};

export async function writeText(rel: string, content: string, cwd: string): Promise<ToolResult> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `${rel} is too large to write (${bytes} bytes).` };
  }

  // Open an existing file and check it before changing any byte. A missing file
  // is created only after the parent directory is checked.
  const opened = await openInside(rel, cwd, "r+");
  if (opened.ok) return overwrite(opened.handle, rel, content);
  if (!opened.missing) return { ok: false, error: opened.error };

  const created = await createInside(rel, cwd, content);
  if (!created.ok) return { ok: false, error: created.error };
  return { ok: true, output: `Wrote ${rel}` };
}

async function overwrite(handle: FileHandle, rel: string, content: string): Promise<ToolResult> {
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, error: `${rel} is not a file.` };
    await handle.truncate(0);
    await handle.writeFile(content);
    return { ok: true, output: `Wrote ${rel}` };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  } finally {
    await handle.close();
  }
}
