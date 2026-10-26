import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, type CliIo } from "../src/cli.js";

function io(cwd: string, env: NodeJS.ProcessEnv = {}): CliIo & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    cwd,
    env,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    out: () => out,
    err: () => err,
  };
}

test("prints help", async () => {
  const streams = io(process.cwd());
  const code = await main(["--help"], streams);
  assert.equal(code, 0);
  assert.match(streams.out(), /read_file/);
  assert.match(streams.out(), /OPENAI_API_KEY/);
});

test("names the provider API key when it is missing", async () => {
  const streams = io(process.cwd(), {});
  const code = await main(["-p", "Read sample.txt", "--provider", "openai", "--model", "gpt-4o-mini"], streams);
  assert.equal(code, 1);
  assert.match(streams.err(), /OPENAI_API_KEY/);
});

test("faux provider reads a file and prints the tool call to stderr", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-cli-"));
  try {
    await writeFile(path.join(dir, "sample.txt"), "contents-from-disk\n");
    const streams = io(dir);
    const code = await main(["-p", "Read sample.txt and quote it", "--provider", "faux", "--cwd", dir], streams);
    assert.equal(code, 0);
    assert.match(streams.err(), /tool read_file \{"path":"sample.txt"\}/);
    assert.match(streams.out(), /contents-from-disk/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a piped answer larger than the pipe buffer is delivered whole", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-cli-pipe-"));
  try {
    // Large enough that exiting before the pipe drains drops the tail.
    const payload = `${"a".repeat(150_000)}\n`;
    await writeFile(path.join(dir, "sample.txt"), payload);
    const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const result = await run(process.execPath, [
      tsx,
      cli,
      "-p",
      "Read sample.txt",
      "--provider",
      "faux",
      "--cwd",
      dir,
    ]);
    const expected = `The file says:\n${payload}`;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.length, expected.length);
    assert.equal(result.stdout, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the cli process runs the faux model end to end", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-cli-proc-"));
  try {
    await writeFile(path.join(dir, "sample.txt"), "from-the-process\n");
    const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const result = await run(process.execPath, [tsx, cli, "-p", "Read sample.txt", "--provider", "faux", "--cwd", dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /tool read_file \{"path":"sample.txt"\}/);
    assert.match(result.stdout, /from-the-process/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
