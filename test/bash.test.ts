import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { BASH_MAX_STREAM_BYTES, bashTool, runBash } from "../src/bash.js";

let work = "";

before(async () => {
  work = await mkdtemp(path.join(tmpdir(), "myagent-bash-"));
});

after(async () => {
  await rm(work, { recursive: true, force: true });
});

test("returns exit code, stdout, and stderr, including a non-zero exit", async () => {
  const ok = await bashTool.run({ command: "echo hi" }, { cwd: work });
  assert.deepEqual(ok, { ok: true, output: "exit_code: 0\nstdout:\nhi\nstderr:\n" });

  const failed = await bashTool.run({ command: "echo no; echo bad >&2; exit 4" }, { cwd: work });
  assert.deepEqual(failed, { ok: true, output: "exit_code: 4\nstdout:\nno\nstderr:\nbad\n" });
});

test("runs in the working directory", async () => {
  await writeFile(path.join(work, "only-here.txt"), "marker\n");
  const result = await bashTool.run({ command: "cat only-here.txt" }, { cwd: work });
  assert.deepEqual(result, { ok: true, output: "exit_code: 0\nstdout:\nmarker\nstderr:\n" });
});

test("truncates long output and says it was truncated", async () => {
  const node = process.execPath.replaceAll("'", `'\\''`);
  const command = `'${node}' -e "process.stdout.write('\\u20ac'.repeat(40000))"`;
  const result = await bashTool.run({ command }, { cwd: work });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const marker = "stdout (truncated):\n";
  const start = result.output.indexOf(marker);
  assert.ok(start >= 0);
  const after = result.output.slice(start + marker.length);
  const stderrAt = after.indexOf("\nstderr:");
  assert.ok(stderrAt >= 0);
  const stdout = after.slice(0, stderrAt);
  assert.equal(Buffer.byteLength(stdout, "utf8"), 99_999);
  assert.ok(Buffer.byteLength(stdout, "utf8") <= BASH_MAX_STREAM_BYTES);
  assert.equal(stdout, "\u20ac".repeat(33_333));
  assert.equal(stdout.includes("\uFFFD"), false);
  assert.match(result.output, /exit_code: 0/);
});

test("kills a command that exceeds the timeout", { timeout: 5_000 }, async () => {
  const started = Date.now();
  const result = await runBash("sleep 30", work, 200);
  assert.deepEqual(result, { ok: false, error: "Command timed out after 200ms." });
  assert.ok(Date.now() - started < 5_000);
});

test("parse rejects arguments that are not a command", () => {
  assert.throws(() => bashTool.parse({}), /Validation failed/);
  assert.throws(() => bashTool.parse([]), /object/);
});
