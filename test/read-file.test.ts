import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { readFileTool } from "../src/read-file.js";

let root = "";
let work = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "myagent-read-"));
  work = path.join(root, "work");
  await mkdir(work);
  await mkdir(path.join(work, "sub"));
  await writeFile(path.join(work, "note.txt"), "note body");
  await writeFile(path.join(root, "secret.txt"), "secret");
  await symlink(path.join(root, "secret.txt"), path.join(work, "leak.txt"));
  await writeFile(path.join(work, "binary.txt"), "ok\0no");
  await writeFile(path.join(work, "big.txt"), "x".repeat(200_001));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function read(file: string) {
  const args = readFileTool.parse({ path: file });
  return readFileTool.run(args, { cwd: work });
}

test("reads a relative file, including a path that uses .. inside cwd", async () => {
  const direct = await read("note.txt");
  assert.deepEqual(direct, { ok: true, output: "note body" });
  const nested = await read("sub/../note.txt");
  assert.deepEqual(nested, { ok: true, output: "note body" });
});

test("returns ok: false for a missing file, a directory, and a binary file", async () => {
  assert.deepEqual(await read("missing.txt"), { ok: false, error: "No such file: missing.txt" });
  const directory = await read("sub");
  assert.equal(directory.ok, false);
  if (!directory.ok) assert.match(directory.error, /not a file/);
  const binary = await read("binary.txt");
  assert.equal(binary.ok, false);
  if (!binary.ok) assert.match(binary.error, /not a UTF-8 text file/);
});

test("returns ok: false when the path leaves the working directory", async () => {
  const parent = await read("../secret.txt");
  assert.deepEqual(parent, { ok: false, error: "Path escapes the working directory." });

  const absolute = await readFileTool.run({ path: path.join(work, "note.txt") }, { cwd: work });
  assert.equal(absolute.ok, false);
  if (!absolute.ok) assert.match(absolute.error, /relative/);

  const link = await read("leak.txt");
  assert.deepEqual(link, { ok: false, error: "Path escapes the working directory." });
});

test("returns ok: false for a file over the size cap", async () => {
  const big = await read("big.txt");
  assert.equal(big.ok, false);
  if (!big.ok) assert.match(big.error, /too large/);
});

test("parse rejects arguments that are not a path string", () => {
  assert.throws(() => readFileTool.parse({}), /Validation failed/);
  assert.throws(() => readFileTool.parse("note.txt"), /object/);
});
