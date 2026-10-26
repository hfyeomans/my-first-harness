import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { readFileTool } from "../src/read-file.js";
import { MAX_FILE_BYTES } from "../src/workspace-path.js";
import { writeFileTool } from "../src/write-file.js";

let root = "";
let work = "";
let outside = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "myagent-write-"));
  work = path.join(root, "work");
  outside = path.join(root, "outside");
  await mkdir(work);
  await mkdir(path.join(work, "sub"));
  await mkdir(outside);
  await writeFile(path.join(work, "note.txt"), "note body");
  await writeFile(path.join(root, "secret.txt"), "secret");
  await symlink(path.join(root, "secret.txt"), path.join(work, "leak.txt"));
  await symlink(outside, path.join(work, "linked-dir"));
  await symlink(path.join(work, "note.txt"), path.join(work, "alias.txt"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(file: string, content: string) {
  const args = writeFileTool.parse({ path: file, content });
  return writeFileTool.run(args, { cwd: work });
}

test("creates a file, overwrites it, and stays inside cwd when the path uses ..", async () => {
  assert.deepEqual(await write("made.txt", "héllo"), { ok: true, output: "Wrote made.txt" });
  assert.equal(await readFile(path.join(work, "made.txt"), "utf8"), "héllo");

  assert.deepEqual(await write("made.txt", "hi"), { ok: true, output: "Wrote made.txt" });
  assert.equal(await readFile(path.join(work, "made.txt"), "utf8"), "hi");

  assert.deepEqual(await write("sub/../nested.txt", "inside"), { ok: true, output: "Wrote sub/../nested.txt" });
  assert.equal(await readFile(path.join(work, "nested.txt"), "utf8"), "inside");

  assert.deepEqual(await write("empty.txt", ""), { ok: true, output: "Wrote empty.txt" });
  assert.equal(await readFile(path.join(work, "empty.txt"), "utf8"), "");

  const exact = "y".repeat(MAX_FILE_BYTES);
  assert.equal((await write("exact.txt", exact)).ok, true);
  assert.deepEqual(await readFileTool.run({ path: "exact.txt" }, { cwd: work }), { ok: true, output: exact });
});

test("overwrites through an in-cwd symlink and refuses one that leaves cwd", async () => {
  await writeFile(path.join(work, "note.txt"), "original");
  assert.deepEqual(await write("alias.txt", "changed"), { ok: true, output: "Wrote alias.txt" });
  assert.equal(await readFile(path.join(work, "note.txt"), "utf8"), "changed");
  assert.equal((await lstat(path.join(work, "alias.txt"))).isSymbolicLink(), true);

  const leaked = await write("leak.txt", "pwned");
  assert.deepEqual(leaked, { ok: false, error: "Path escapes the working directory." });
  assert.equal(await readFile(path.join(root, "secret.txt"), "utf8"), "secret");

  const planted = await write("linked-dir/planted.txt", "pwned");
  assert.deepEqual(planted, { ok: false, error: "Path escapes the working directory." });
  await assert.rejects(() => readFile(path.join(outside, "planted.txt"), "utf8"), { code: "ENOENT" });
});

test("returns ok: false and writes nothing for a bad path or an oversized body", async () => {
  await writeFile(path.join(work, "keep.txt"), "keep");

  const directory = await write("sub", "x");
  assert.equal(directory.ok, false);
  if (!directory.ok) assert.match(directory.error, /not a file/);

  assert.deepEqual(await write("missing/file.txt", "x"), {
    ok: false,
    error: "No such directory: missing",
  });
  await assert.rejects(() => readFile(path.join(work, "missing", "file.txt"), "utf8"), { code: "ENOENT" });

  const absolute = await writeFileTool.run({ path: path.join(work, "keep.txt"), content: "nope" }, { cwd: work });
  assert.equal(absolute.ok, false);
  if (!absolute.ok) assert.match(absolute.error, /relative/);

  assert.deepEqual(await write("../secret.txt", "nope"), {
    ok: false,
    error: "Path escapes the working directory.",
  });
  assert.equal(await readFile(path.join(root, "secret.txt"), "utf8"), "secret");

  const big = await write("keep.txt", "x".repeat(MAX_FILE_BYTES + 1));
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.error, /too large to write/);
  assert.equal(await readFile(path.join(work, "keep.txt"), "utf8"), "keep");
});

test("overwrites a write-only file", async () => {
  const file = path.join(work, "wo.txt");
  await writeFile(file, "old");
  await chmod(file, 0o200);
  assert.deepEqual(await write("wo.txt", "new"), { ok: true, output: "Wrote wo.txt" });
  await chmod(file, 0o644);
  assert.equal(await readFile(file, "utf8"), "new");
});

test("a failed write leaves the original file and no partial file", { timeout: 20_000 }, async () => {
  const mount = `/tmp/tinyfs-${process.pid}-${Date.now()}`;
  const script = path.join("/workspace", `.full-disk-${process.pid}.ts`);
  const lines = [
    `import { mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";`,
    `import { spawnSync } from "node:child_process";`,
    `import path from "node:path";`,
    `import { writeText } from "/workspace/src/write-file.ts";`,
    `const mount = ${JSON.stringify(mount)};`,
    `await mkdir(mount, { recursive: true });`,
    `const mounted = spawnSync("mount", ["-t", "tmpfs", "-o", "size=64k", "tmpfs", mount], { encoding: "utf8" });`,
    `if (mounted.status !== 0) { console.error(mounted.stderr || mounted.stdout); process.exit(2); }`,
    `try {`,
    `  const keep = path.join(mount, "keep.txt");`,
    `  await writeFile(keep, "original-contents\\n");`,
    `  const pad = await open(path.join(mount, "pad"), "w");`,
    `  const chunk = Buffer.alloc(4096, 0x61);`,
    `  try { for (;;) await pad.write(chunk); } catch (err) { const code = err && typeof err === "object" && "code" in err ? err.code : undefined; if (code !== "ENOSPC") throw err; } finally { await pad.close(); }`,
    `  const result = await writeText("keep.txt", "n".repeat(20000), mount);`,
    `  const created = await writeText("fresh.txt", "new file\\n", mount);`,
    `  const body = await readFile(keep, "utf8");`,
    `  const names = await readdir(mount);`,
    `  console.log(JSON.stringify({ result, created, body, names }));`,
    `} finally {`,
    `  spawnSync("umount", [mount]);`,
    `  await rm(mount, { recursive: true, force: true });`,
    `}`,
  ];
  await writeFile(script, lines.join("\n"));

  const tsx = "/workspace/node_modules/tsx/dist/cli.mjs";
  let output: { code: number | null; stdout: string; stderr: string };
  try {
    output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("unshare", ["--user", "--map-root-user", "--mount", process.execPath, tsx, script], {
        cwd: "/workspace",
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
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await rm(script, { force: true });
  }

  assert.equal(output.code, 0, output.stderr);
  const parsed = JSON.parse(output.stdout) as {
    result: { ok: boolean };
    created: { ok: boolean };
    body: string;
    names: string[];
  };
  assert.equal(parsed.result.ok, false);
  assert.equal(parsed.created.ok, false);
  assert.equal(parsed.body, "original-contents\n");
  assert.equal(parsed.names.includes("fresh.txt"), false);
  assert.equal(
    parsed.names.some((name) => name.startsWith(".myagent-")),
    false,
  );
});

test("parse rejects arguments that are not a path and contents", () => {
  assert.throws(() => writeFileTool.parse({ path: "a.txt" }), /Validation failed/);
  assert.throws(() => writeFileTool.parse("a.txt"), /object/);
});
