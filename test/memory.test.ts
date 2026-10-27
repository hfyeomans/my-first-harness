import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { runAgent } from "../src/loop.js";
import { finalAnswer } from "../src/messages.js";
import {
  MAX_NOTE_CHARS,
  MEMORY_SNAPSHOT_BYTES,
  memoryPath,
  readMemory,
  rememberTool,
} from "../src/memory.js";
import type { AgentModel } from "../src/types.js";

test("a missing memory file is an empty snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-memory-miss-"));
  try {
    assert.equal(await readMemory(dir), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remember appends one bullet and creates a private file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-memory-add-"));
  try {
    assert.deepEqual(await rememberTool.run({ note: "  tests use real databases  " }, { cwd: dir }), {
      ok: true,
      output: "Remembered: tests use real databases",
    });
    const file = memoryPath(dir);
    assert.equal(await readFile(file, "utf8"), "- tests use real databases\n");
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    assert.deepEqual(await rememberTool.run({ note: "prefer pnpm" }, { cwd: dir }), {
      ok: true,
      output: "Remembered: prefer pnpm",
    });
    assert.equal(await readFile(file, "utf8"), "- tests use real databases\n- prefer pnpm\n");
    assert.equal(await readMemory(dir), "- tests use real databases\n- prefer pnpm\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remember refuses an empty note, a line break, and a note that is too long", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-memory-bad-"));
  try {
    assert.throws(() => rememberTool.parse({}), /Validation failed/);
    assert.throws(() => rememberTool.parse({ note: "n".repeat(MAX_NOTE_CHARS + 1) }), /Validation failed/);
    assert.deepEqual(await rememberTool.run({ note: "   " }, { cwd: dir }), {
      ok: false,
      error: "A note must not be empty.",
    });
    assert.deepEqual(await rememberTool.run({ note: "one\ntwo" }, { cwd: dir }), {
      ok: false,
      error: "A note must be one line.",
    });
    await assert.rejects(readFile(memoryPath(dir), "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a note is appended after a file that does not end in a newline", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-memory-join-"));
  try {
    await mkdir(path.join(dir, ".myagent"));
    await writeFile(memoryPath(dir), "- already here");
    assert.deepEqual(await rememberTool.run({ note: "second" }, { cwd: dir }), {
      ok: true,
      output: "Remembered: second",
    });
    assert.equal(await readFile(memoryPath(dir), "utf8"), "- already here\n- second\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the snapshot is the tail of a long file and the file is left whole", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-memory-tail-"));
  try {
    const file = memoryPath(dir);
    await mkdir(path.dirname(file));
    const first = "- FIRST-NOTE-UNIQUE\n";
    const filler = `- ${"m".repeat(40)}\n`;
    const last = "- LAST-NOTE-UNIQUE\n";
    const body = first + filler.repeat(Math.ceil(MEMORY_SNAPSHOT_BYTES / filler.length) + 2) + last;
    assert.ok(Buffer.byteLength(body) > MEMORY_SNAPSHOT_BYTES);
    await writeFile(file, body);

    const snapshot = await readMemory(dir);
    assert.ok(snapshot.startsWith("[earlier notes omitted]\n"));
    assert.match(snapshot, /LAST-NOTE-UNIQUE/);
    assert.doesNotMatch(snapshot, /FIRST-NOTE-UNIQUE/);
    assert.ok(Buffer.byteLength(snapshot) < MEMORY_SNAPSHOT_BYTES);
    assert.equal(await readFile(file, "utf8"), body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a snapshot cut mid-character still decodes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-memory-utf8-"));
  try {
    const file = memoryPath(dir);
    await mkdir(path.dirname(file));
    // One leading byte puts the 8000-byte tail on a continuation byte of "é".
    const body = `x${"é".repeat(5000)}\n- LAST-NOTE-UNIQUE\n`;
    assert.ok(Buffer.byteLength(body) > MEMORY_SNAPSHOT_BYTES);
    await writeFile(file, body);
    const snapshot = await readMemory(dir);
    assert.match(snapshot, /LAST-NOTE-UNIQUE/);
    assert.equal(snapshot.includes("\uFFFD"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a memory file that is not UTF-8 or not a file fails before it can be snapshotted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-memory-badfile-"));
  try {
    const file = memoryPath(dir);
    await mkdir(path.dirname(file));
    await writeFile(file, Buffer.from([0xff]));
    await assert.rejects(readMemory(dir), /\.myagent\/MEMORY\.md is not valid UTF-8/);

    await writeFile(file, "fine\0hidden\n");
    await assert.rejects(readMemory(dir), /\.myagent\/MEMORY\.md contains a NUL byte/);

    await rm(file);
    await mkdir(file);
    await assert.rejects(readMemory(dir), /\.myagent\/MEMORY\.md is not a file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the loop hands a remembered note back to the model", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-memory-loop-"));
  try {
    const model = scripted([
      fauxAssistantMessage([fauxToolCall("remember", { note: "prefer pnpm" }, { id: "m1" })], {
        stopReason: "toolUse",
      }),
      (history) => fauxAssistantMessage(toolText(history)),
    ]);
    const messages = await runAgent([{ role: "user", content: "remember that", timestamp: 1 }], [rememberTool], {
      model,
      cwd: dir,
    });
    assert.equal(model.calls, 2);
    assert.equal(finalAnswer(messages), "Remembered: prefer pnpm");
    assert.equal(await readFile(memoryPath(dir), "utf8"), "- prefer pnpm\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function scripted(steps: (AssistantMessage | ((history: readonly Message[]) => AssistantMessage))[]): AgentModel & {
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete(history) {
      const step = steps[calls];
      calls += 1;
      if (!step) throw new Error(`model called ${calls} times; script has ${steps.length}`);
      return typeof step === "function" ? step(history) : step;
    },
  };
}

function toolText(history: readonly Message[]): string {
  const message = history.at(-1);
  if (message?.role !== "toolResult" || message.isError) throw new Error("expected a successful tool result");
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}
