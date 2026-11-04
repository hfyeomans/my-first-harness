#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { missingApiKey } from "./api-key.js";
import { createFauxModel } from "./faux-model.js";
import { DEFAULT_MAX_TURNS, runAgent } from "./loop.js";
import { readMemory } from "./memory.js";
import { finalAnswer } from "./messages.js";
import { loadPiModel } from "./pi-model.js";
import { agentTools } from "./registry.js";
import { createSession, parseSessionId, resumeSession, SESSIONS_SUBDIR } from "./session.js";

const HELP = `myagent — agent loop with read_file, write_file, edit_file, bash, and remember

Usage:
  myagent -p "Read sample.txt" --provider faux
  myagent -p 'Edit sample.txt, replace "hello" with "goodbye", and verify' --provider faux
  myagent -p "Read sample.txt" --provider anthropic --model claude-haiku-4-5
  myagent --resume -p "What did I ask before?" --provider faux

Options:
  -p, --prompt               Prompt text
      --provider             Provider id, or "faux" for an offline scripted model
                             (env: MYAGENT_PROVIDER)
      --model                Model id (env: MYAGENT_MODEL). Unused for faux.
      --max-turns            Maximum model replies (default ${DEFAULT_MAX_TURNS}, env: MYAGENT_MAX_TURNS)
      --cwd                  Working directory for the tools
      --resume [id]          Continue a session. With no id, the most recent one.
      --sessions-dir         Where sessions are saved (env: MYAGENT_SESSIONS_DIR).
                             Default: ${SESSIONS_SUBDIR} in the working directory.
      --faux-context-window  Context window in tokens for --provider faux, so
                             compaction can run offline
  -h, --help

The API key is that provider's own environment variable, read by
@earendil-works/pi-ai. Examples: OPENAI_API_KEY, ANTHROPIC_API_KEY
(or ANTHROPIC_OAUTH_TOKEN), GEMINI_API_KEY. There is no MYAGENT_API_KEY.

bash runs with your permissions. This step does not ask before it runs a command.
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
    resume?: string;
    "sessions-dir"?: string;
    "faux-context-window"?: string;
    help?: boolean;
  };
  try {
    const parsed = parseArgs({
      args: withBareResume(argv),
      options: {
        prompt: { type: "string", short: "p" },
        provider: { type: "string" },
        model: { type: "string" },
        "max-turns": { type: "string" },
        cwd: { type: "string" },
        resume: { type: "string" },
        "sessions-dir": { type: "string" },
        "faux-context-window": { type: "string" },
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
  let fauxWindow: number | undefined;
  try {
    maxTurns = parseMaxTurns(values["max-turns"] ?? io.env.MYAGENT_MAX_TURNS);
    fauxWindow = parseFauxWindow(values["faux-context-window"], provider);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const resumeId = values.resume ? parseSessionId(values.resume) : undefined;
  if (values.resume && !resumeId) {
    io.stderr(`--resume: "${values.resume}" is not a session id.\n`);
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
  const sessionsFlag = values["sessions-dir"] ?? io.env.MYAGENT_SESSIONS_DIR;
  const sessionsDir = sessionsFlag ? path.resolve(io.cwd, sessionsFlag) : path.join(cwd, SESSIONS_SUBDIR);

  try {
    // Before the session opens, so an unknown model id or a bad memory file
    // leaves no session file. The snapshot is fixed for this run: remember
    // writes the file, and the next run is what puts that note in the prompt.
    const memory = await readMemory(cwd);
    const model =
      provider === "faux"
        ? createFauxModel({ contextWindow: fauxWindow, memory })
        : await loadPiModel(provider, modelId ?? "", memory);
    const opened =
      values.resume === undefined
        ? await createSession(sessionsDir, { provider, model: modelId ?? "faux", cwd })
        : await resumeSession(sessionsDir, resumeId);
    if (opened.warning) io.stderr(`${opened.warning}\n`);
    io.stderr(`session ${opened.id}\n`);

    const messages = await runAgent([{ role: "user", content: prompt, timestamp: Date.now() }], agentTools, {
      model,
      maxTurns,
      cwd,
      session: opened.session,
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

function parseFauxWindow(raw: string | undefined, provider: string): number | undefined {
  if (raw === undefined) return undefined;
  if (provider !== "faux") throw new Error("--faux-context-window only works with --provider faux.");
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`--faux-context-window must be a positive integer, got "${raw}".`);
  }
  return Number(raw);
}

// Strict parseArgs throws on a string option with no value. `--resume=` parses
// as "", which means the most recent session.
function withBareResume(argv: readonly string[]): string[] {
  const end = argv.indexOf("--");
  return argv.map((arg, index) => {
    if (arg !== "--resume" || (end !== -1 && index > end)) return arg;
    const next = argv[index + 1];
    return next === undefined || next.startsWith("-") ? "--resume=" : arg;
  });
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
