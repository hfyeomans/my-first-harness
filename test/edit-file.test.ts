import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { editFileTool } from "../src/edit-file.js";

let root = "";
let work = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "myagent-edit-"));
  work = path.join(root, "work");
  await mkdir(work);
  await writeFile(path.join(root, "secret.txt"), "secret");
  await symlink(path.join(root, "secret.txt"), path.join(work, "leak.txt"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function edit(file: string, oldString: string, newString: string) {
  const args = editFileTool.parse({ path: file, old_string: oldString, new_string: newString });
  return editFileTool.run(args, { cwd: work });
}

test("replaces one literal match, including across lines", async () => {
  await writeFile(path.join(work, "lit.txt"), "a.b aXb");
  assert.deepEqual(await edit("lit.txt", "a.b", "Z"), { ok: true, output: "Edited lit.txt" });
  assert.equal(await readFile(path.join(work, "lit.txt"), "utf8"), "Z aXb");

  await writeFile(path.join(work, "lines.txt"), "alpha\nbeta\ngamma\n");
  assert.deepEqual(await edit("lines.txt", "beta\ngamma", "BETA\nGAMMA"), {
    ok: true,
    output: "Edited lines.txt",
  });
  assert.equal(await readFile(path.join(work, "lines.txt"), "utf8"), "alpha\nBETA\nGAMMA\n");
});

test("leaves the file unchanged when old_string is missing or repeated", async () => {
  const file = path.join(work, "dup.txt");
  await writeFile(file, "one one");

  const missing = await edit("dup.txt", "gone", "two");
  assert.deepEqual(missing, { ok: false, error: "old_string was not found in dup.txt." });
  assert.equal(await readFile(file, "utf8"), "one one");

  const repeated = await edit("dup.txt", "one", "two");
  assert.deepEqual(repeated, {
    ok: false,
    error: "old_string appears 2 times in dup.txt. Include more surrounding text so it matches once.",
  });
  assert.equal(await readFile(file, "utf8"), "one one");

  assert.deepEqual(await edit("dup.txt", "one one", "two"), { ok: true, output: "Edited dup.txt" });
  assert.equal(await readFile(file, "utf8"), "two");
});

test("returns the read error and does not change bytes the reader refuses", async () => {
  const nul = path.join(work, "nul.txt");
  const bytes = Buffer.from("ok\0no");
  await writeFile(nul, bytes);
  assert.deepEqual(await edit("nul.txt", "ok", "no"), { ok: false, error: "nul.txt contains a NUL byte." });
  assert.deepEqual(await readFile(nul), bytes);

  assert.deepEqual(await edit("missing.txt", "a", "b"), { ok: false, error: "No such file: missing.txt" });
  assert.deepEqual(await edit("leak.txt", "secret", "nope"), {
    ok: false,
    error: "Path escapes the working directory.",
  });
  assert.equal(await readFile(path.join(root, "secret.txt"), "utf8"), "secret");
});

test("parse rejects arguments that are not one exact replacement", () => {
  assert.throws(() => editFileTool.parse({ path: "a.txt" }), /Validation failed/);
  assert.throws(() => editFileTool.parse("a.txt"), /object/);
  assert.throws(
    () => editFileTool.parse({ path: "a.txt", old_string: "", new_string: "x" }),
    /Validation failed/,
  );
});
