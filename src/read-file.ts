import { Type, type Static } from "@earendil-works/pi-ai";
import { parseArguments } from "./parse-args.js";
import type { Tool, ToolResult } from "./types.js";
import { MAX_FILE_BYTES, errorText, openInside } from "./workspace-path.js";

const DESCRIPTION = `Read a UTF-8 text file. The path is relative to the working directory and must stay inside it. Refuses directories, files that are not valid UTF-8, files that contain a NUL byte, and files larger than ${MAX_FILE_BYTES} bytes.`;

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
    return parseArguments<ReadFileArgs>("read_file", DESCRIPTION, parameters, args);
  },
  run(args, ctx) {
    return readFileAt(args.path, ctx.cwd);
  },
};

async function readFileAt(rel: string, cwd: string): Promise<ToolResult> {
  // openInside rejects paths that leave cwd, including through a symlink.
  const opened = await openInside(rel, cwd, "r");
  if (!opened.ok) return { ok: false, error: opened.error };

  const fh = opened.handle;
  try {
    const info = await fh.stat();
    if (!info.isFile()) return { ok: false, error: `${rel} is not a file.` };
    if (info.size > MAX_FILE_BYTES) {
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
