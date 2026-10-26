import { Type, type Static } from "@earendil-works/pi-ai";
import { parseArguments } from "./parse-args.js";
import { readFileTool } from "./read-file.js";
import type { Tool, ToolResult } from "./types.js";
import { MAX_FILE_BYTES, commitInside } from "./workspace-path.js";

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

export async function writeText(rel: string, content: string, cwd: string, expected?: string): Promise<ToolResult> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, error: `${rel} is too large to write (${bytes} bytes).` };
  }

  // `expected` is the text edit_file read. After the temp file is synced, read
  // again and skip the rename if the file changed. There is no lock.
  const written = await commitInside(rel, cwd, content, expected === undefined ? undefined : async () => {
    const again = await readFileTool.run({ path: rel }, { cwd });
    if (!again.ok) return again.error;
    if (again.output !== expected) return `${rel} changed while editing. Read it and try again.`;
    return undefined;
  });
  if (!written.ok) return { ok: false, error: written.error };
  return { ok: true, output: `Wrote ${rel}` };
}
