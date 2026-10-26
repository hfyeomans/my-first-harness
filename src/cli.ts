#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { missingApiKey } from "./api-key.js";
import { createFauxModel } from "./faux-model.js";
import { DEFAULT_MAX_TURNS, runAgent } from "./loop.js";
import { finalAnswer } from "./messages.js";
import { loadPiModel } from "./pi-model.js";
import { readFileTool } from "./read-file.js";

const HELP = `myagent — agent loop with one tool, read_file

Usage:
  myagent -p "Read sample.txt" --provider faux
  myagent -p "Read sample.txt" --provider openai --model gpt-4o-mini

Options:
  -p, --prompt     Prompt text
      --provider   Provider id, or "faux" for an offline scripted model
                   (env: MYAGENT_PROVIDER)
      --model      Model id (env: MYAGENT_MODEL). Unused for faux.
      --max-turns  Maximum model calls (default ${DEFAULT_MAX_TURNS}, env: MYAGENT_MAX_TURNS)
      --cwd        Working directory for read_file
  -h, --help

The API key is that provider's own environment variable, read by
@earendil-works/pi-ai. Examples: OPENAI_API_KEY, ANTHROPIC_API_KEY
(or ANTHROPIC_OAUTH_TOKEN), GEMINI_API_KEY. There is no MYAGENT_API_KEY.
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  let values: {
    prompt?: string;
    provider?: string;
    model?: string;
    "max-turns"?: string;
    cwd?: string;
    help?: boolean;
  };
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        prompt: { type: "string", short: "p" },
        provider: { type: "string" },
        model: { type: "string" },
        "max-turns": { type: "string" },
        cwd: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
    values = parsed.values;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (values.help) {
    io.stdout(HELP);
    return 0;
  }

  const prompt = values.prompt;
  if (!prompt || prompt.trim() === "") {
    io.stderr("Missing --prompt (-p).\n");
    return 1;
  }

  const provider = values.provider ?? io.env.MYAGENT_PROVIDER;
  if (!provider) {
    io.stderr("Missing --provider (or MYAGENT_PROVIDER). Use --provider faux to run offline.\n");
    return 1;
  }

  const modelId = values.model ?? io.env.MYAGENT_MODEL;
  if (provider !== "faux" && !modelId) {
    io.stderr("Missing --model (or MYAGENT_MODEL).\n");
    return 1;
  }

  let maxTurns: number;
  try {
    maxTurns = parseMaxTurns(values["max-turns"] ?? io.env.MYAGENT_MAX_TURNS);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (provider !== "faux") {
    const hint = missingApiKey(provider, io.env);
    if (hint) {
      io.stderr(`${hint}\n`);
      return 1;
    }
  }

  const cwd = path.resolve(values.cwd ?? io.cwd);
  const history: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];

  try {
    const model =
      provider === "faux" ? createFauxModel() : await loadPiModel(provider, modelId ?? "");
    const messages = await runAgent(history, [readFileTool], {
      model,
      maxTurns,
      cwd,
      onToolCall(call) {
        io.stderr(`tool ${call.name} ${JSON.stringify(call.arguments)}\n`);
      },
    });
    const answer = finalAnswer(messages);
    if (answer === undefined) {
      io.stderr(`stopped after ${maxTurns} model turns\n`);
      return 1;
    }
    io.stdout(answer.endsWith("\n") ? answer : `${answer}\n`);
    return 0;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function parseMaxTurns(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MAX_TURNS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`--max-turns must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  main(process.argv.slice(2), {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    cwd: process.cwd(),
  }).then(
    (code) => {
      // A full pipe flushes only after we return to the event loop. process.exit
      // drops that queue, so a large answer can leave with status 0 and be cut off.
      process.exitCode = code;
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
