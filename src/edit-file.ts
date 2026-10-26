import { Type, type Static } from "@earendil-works/pi-ai";
import { parseArguments } from "./parse-args.js";
import { readFileTool } from "./read-file.js";
import type { Tool, ToolResult } from "./types.js";
import { writeText } from "./write-file.js";

const DESCRIPTION =
  "Replace one exact occurrence of old_string with new_string in a UTF-8 file. The path is relative to the working directory and must stay inside it. Fails if old_string is missing or appears more than once; include more surrounding text so the match is unique, then retry. The match is literal text, not a regular expression.";

const parameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      description: "Path relative to the working directory",
    }),
    old_string: Type.String({
      minLength: 1,
      description: "Exact text to replace. It must occur once in the file.",
    }),
    new_string: Type.String({ description: "Replacement text. May be empty." }),
  },
  { additionalProperties: false },
);

type EditFileArgs = Static<typeof parameters>;

export const editFileTool: Tool<EditFileArgs> = {
  name: "edit_file",
  description: DESCRIPTION,
  parameters,
  parse(args: unknown): EditFileArgs {
    return parseArguments<EditFileArgs>("edit_file", DESCRIPTION, parameters, args);
  },
  run(args, ctx) {
    return editFileAt(args.path, args.old_string, args.new_string, ctx.cwd);
  },
};

async function editFileAt(rel: string, oldString: string, newString: string, cwd: string): Promise<ToolResult> {
  if (oldString.length === 0) return { ok: false, error: "old_string is empty." };

  // Read first, and write only after the match is unique, so a failed edit
  // does not change the file.
  const current = await readFileTool.run({ path: rel }, { cwd });
  if (!current.ok) return current;

  const count = occurrences(current.output, oldString);
  if (count === 0) return { ok: false, error: `old_string was not found in ${rel}.` };
  if (count > 1) {
    return {
      ok: false,
      error: `old_string appears ${count} times in ${rel}. Include more surrounding text so it matches once.`,
    };
  }

  const at = current.output.indexOf(oldString);
  const next = current.output.slice(0, at) + newString + current.output.slice(at + oldString.length);
  const written = await writeText(rel, next, cwd, current.output);
  if (!written.ok) return written;
  return { ok: true, output: `Edited ${rel}` };
}

function occurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    // Step one character so `aa` inside `aaa` counts twice.
    from = at + 1;
  }
  return count;
}
