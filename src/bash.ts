import { spawn } from "node:child_process";
import { Type, type Static } from "@earendil-works/pi-ai";
import { parseArguments } from "./parse-args.js";
import type { Tool, ToolResult } from "./types.js";
import { errorText } from "./workspace-path.js";

export const BASH_TIMEOUT_MS = 30_000;
export const BASH_MAX_STREAM_BYTES = 100_000;

const DESCRIPTION = `Run a bash command in the working directory and return its exit code, stdout, and stderr. A non-zero exit is a normal result. Each stream is truncated after ${BASH_MAX_STREAM_BYTES} bytes. The command is killed after ${BASH_TIMEOUT_MS}ms.`;

const parameters = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      description: "Bash command to run in the working directory",
    }),
  },
  { additionalProperties: false },
);

type BashArgs = Static<typeof parameters>;

export const bashTool: Tool<BashArgs> = {
  name: "bash",
  description: DESCRIPTION,
  parameters,
  parse(args: unknown): BashArgs {
    return parseArguments<BashArgs>("bash", DESCRIPTION, parameters, args);
  },
  run(args, ctx) {
    return runBash(args.command, ctx.cwd);
  },
};

export function runBash(command: string, cwd: string, timeoutMs = BASH_TIMEOUT_MS): Promise<ToolResult> {
  return new Promise((resolve) => {
    // detached starts a new process group so a timeout can kill the command and
    // anything it started. Killing only bash leaves children holding the pipes,
    // and the tool would wait until those children exit.
    const child = spawn("bash", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process already exited.
        }
      }
    };

    // If this process exits first, don't leave the command running.
    const onExit = (): void => {
      killGroup();
    };
    process.on("exit", onExit);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("exit", onExit);
      resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      killGroup();
      finish({ ok: false, error: "Failed to capture command output." });
      return;
    }

    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      if (stdoutTruncated) return;
      const next = capUtf8(stdout + chunk, BASH_MAX_STREAM_BYTES);
      stdout = next.text;
      stdoutTruncated = next.truncated;
    });
    stderrStream.on("data", (chunk: string) => {
      if (stderrTruncated) return;
      const next = capUtf8(stderr + chunk, BASH_MAX_STREAM_BYTES);
      stderr = next.text;
      stderrTruncated = next.truncated;
    });

    child.on("error", (err) => {
      finish({ ok: false, error: errorText(err) });
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({ ok: false, error: `Command timed out after ${timeoutMs}ms.` });
        return;
      }
      finish({
        ok: true,
        output: formatOutput(code, signal, stdout, stderr, stdoutTruncated, stderrTruncated),
      });
    });
  });
}

function formatOutput(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
): string {
  let text = `exit_code: ${exitCode === null ? "none" : exitCode}\n`;
  if (signal) text += `signal: ${signal}\n`;
  text += `${stdoutTruncated ? "stdout (truncated):" : "stdout:"}\n`;
  text += stdout;
  if (!stdout.endsWith("\n")) text += "\n";
  text += `${stderrTruncated ? "stderr (truncated):" : "stderr:"}\n`;
  text += stderr;
  if (stderr.length > 0 && !stderr.endsWith("\n")) text += "\n";
  return text;
}

// If the cut lands inside a UTF-8 character, step back to its first byte and
// exclude it, so the prefix stays valid text.
function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}
