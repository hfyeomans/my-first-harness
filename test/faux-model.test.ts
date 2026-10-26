import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFauxModel } from "../src/faux-model.js";
import { runAgent } from "../src/loop.js";
import { finalAnswer, toolCallsOf } from "../src/messages.js";
import { agentTools } from "../src/registry.js";
import type { Message } from "../src/types.js";

function user(content: string): Message {
  return { role: "user", content, timestamp: 1 };
}

test("faux model reads a file, edits it, and verifies with bash", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-faux-"));
  try {
    await writeFile(path.join(dir, "sample.txt"), "hello from disk\n");
    const seen: string[] = [];
    const messages = await runAgent(
      [user('Edit sample.txt, replace "hello" with "goodbye", and verify')],
      agentTools,
      {
        model: createFauxModel(),
        cwd: dir,
        onToolCall: (call) => seen.push(call.name),
      },
    );

    assert.deepEqual(seen, ["read_file", "edit_file", "bash"]);
    const calls = messages.flatMap((message) => (message.role === "assistant" ? toolCallsOf(message) : []));
    assert.equal(calls[2]?.arguments["command"], "grep -F -n -- 'goodbye' 'sample.txt'");
    for (const message of messages) {
      if (message.role === "toolResult") assert.equal(message.isError, false);
    }
    assert.equal(await readFile(path.join(dir, "sample.txt"), "utf8"), "goodbye from disk\n");
    const answer = finalAnswer(messages) ?? "";
    assert.match(answer, /Updated sample\.txt/);
    assert.match(answer, /exit_code: 0/);
    assert.match(answer, /goodbye from disk/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("faux model stops when the edit match is not unique and does not change the file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-faux-dup-"));
  try {
    await writeFile(path.join(dir, "sample.txt"), "hello hello\n");
    const seen: string[] = [];
    const messages = await runAgent(
      [user('Edit sample.txt, replace "hello" with "goodbye", and verify')],
      agentTools,
      {
        model: createFauxModel(),
        cwd: dir,
        onToolCall: (call) => seen.push(call.name),
      },
    );
    assert.deepEqual(seen, ["read_file", "edit_file"]);
    assert.match(finalAnswer(messages) ?? "", /appears 2 times/);
    assert.equal(await readFile(path.join(dir, "sample.txt"), "utf8"), "hello hello\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("faux model stops when old_string is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-faux-miss-"));
  try {
    await writeFile(path.join(dir, "sample.txt"), "hello\n");
    const messages = await runAgent(
      [user('Edit sample.txt, replace "goodbye" with "nope", and verify')],
      agentTools,
      { model: createFauxModel(), cwd: dir },
    );
    assert.match(finalAnswer(messages) ?? "", /old_string was not found in sample\.txt/);
    assert.equal(await readFile(path.join(dir, "sample.txt"), "utf8"), "hello\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("faux model reports a missing file instead of editing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-faux-gone-"));
  try {
    const seen: string[] = [];
    const messages = await runAgent(
      [user('Edit missing.txt, replace "a" with "b", and verify')],
      agentTools,
      {
        model: createFauxModel(),
        cwd: dir,
        onToolCall: (call) => seen.push(call.name),
      },
    );
    assert.deepEqual(seen, ["read_file"]);
    assert.match(finalAnswer(messages) ?? "", /No such file: missing\.txt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
