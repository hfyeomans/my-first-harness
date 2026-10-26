import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { bashTool } from "../src/bash.js";
import { editFileTool } from "../src/edit-file.js";
import { runAgent } from "../src/loop.js";
import { finalAnswer } from "../src/messages.js";
import { writeFileTool } from "../src/write-file.js";
import type { AgentModel } from "../src/types.js";

type Step = AssistantMessage | ((history: readonly Message[]) => AssistantMessage);

class ScriptedModel implements AgentModel {
  calls = 0;
  constructor(private readonly steps: Step[]) {}
  async complete(history: readonly Message[]): Promise<AssistantMessage> {
    const step = this.steps[this.calls];
    this.calls += 1;
    if (!step) throw new Error(`model called ${this.calls} times; script has ${this.steps.length}`);
    return typeof step === "function" ? step(history) : step;
  }
}

function user(content: string): Message {
  return { role: "user", content, timestamp: 1 };
}

function call(name: string, args: Record<string, string>, id: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

function toolText(history: readonly Message[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.role !== "toolResult") continue;
    let text = "";
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
    }
    return text;
  }
  throw new Error("expected a tool result");
}

function toolError(history: readonly Message[]): string {
  const message = [...history].reverse().find((entry) => entry.role === "toolResult");
  if (!message || message.role !== "toolResult" || !message.isError) {
    throw new Error("expected a tool error");
  }
  return toolText(history);
}

describe("tools through the loop", () => {
  let root = "";
  let dir = "";

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "myagent-tools-"));
    dir = path.join(root, "work");
    await mkdir(dir);
    await writeFile(path.join(root, "secret.txt"), "secret");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("write_file success is handed back to the model", async () => {
    const model = new ScriptedModel([
      call("write_file", { path: "out.txt", content: "hi\n" }, "w1"),
      (history) => {
        assert.match(toolText(history), /Wrote out\.txt/);
        return fauxAssistantMessage("wrote it");
      },
    ]);
    const messages = await runAgent([user("write")], [writeFileTool], { model, cwd: dir });
    assert.equal(finalAnswer(messages), "wrote it");
    assert.equal(await readFile(path.join(dir, "out.txt"), "utf8"), "hi\n");
  });

  test("write_file failure is handed back to the model and writes nothing", async () => {
    const model = new ScriptedModel([
      call("write_file", { path: "../secret.txt", content: "nope" }, "w2"),
      (history) => fauxAssistantMessage(`recovered: ${toolError(history)}`),
    ]);
    const messages = await runAgent([user("escape")], [writeFileTool], { model, cwd: dir });
    assert.match(finalAnswer(messages) ?? "", /recovered: Path escapes the working directory/);
    assert.equal(await readFile(path.join(root, "secret.txt"), "utf8"), "secret");
  });

  test("edit_file success is handed back to the model", async () => {
    await writeFile(path.join(dir, "note.txt"), "hello\n");
    const model = new ScriptedModel([
      call("edit_file", { path: "note.txt", old_string: "hello", new_string: "goodbye" }, "e1"),
      (history) => {
        assert.equal(toolText(history), "Edited note.txt");
        return fauxAssistantMessage("edited");
      },
    ]);
    const messages = await runAgent([user("edit")], [editFileTool], { model, cwd: dir });
    assert.equal(finalAnswer(messages), "edited");
    assert.equal(await readFile(path.join(dir, "note.txt"), "utf8"), "goodbye\n");
  });

  test("edit_file reports a missing match and leaves the file", async () => {
    await writeFile(path.join(dir, "note.txt"), "hello\n");
    const model = new ScriptedModel([
      call("edit_file", { path: "note.txt", old_string: "absent", new_string: "x" }, "e2"),
      (history) => fauxAssistantMessage(`recovered: ${toolError(history)}`),
    ]);
    const messages = await runAgent([user("edit")], [editFileTool], { model, cwd: dir });
    assert.match(finalAnswer(messages) ?? "", /old_string was not found in note\.txt/);
    assert.equal(await readFile(path.join(dir, "note.txt"), "utf8"), "hello\n");
  });

  test("edit_file reports a repeated match and leaves the file", async () => {
    await writeFile(path.join(dir, "note.txt"), "one one");
    const model = new ScriptedModel([
      call("edit_file", { path: "note.txt", old_string: "one", new_string: "two" }, "e3"),
      (history) => fauxAssistantMessage(`recovered: ${toolError(history)}`),
    ]);
    const messages = await runAgent([user("edit")], [editFileTool], { model, cwd: dir });
    assert.match(finalAnswer(messages) ?? "", /appears 2 times/);
    assert.equal(await readFile(path.join(dir, "note.txt"), "utf8"), "one one");
  });

  test("invalid edit_file arguments are a tool error", async () => {
    const model = new ScriptedModel([
      fauxAssistantMessage([fauxToolCall("edit_file", { path: "note.txt" }, { id: "e4" })], {
        stopReason: "toolUse",
      }),
      (history) => fauxAssistantMessage(`recovered: ${toolError(history)}`),
    ]);
    const messages = await runAgent([user("edit")], [editFileTool], { model, cwd: dir });
    assert.match(finalAnswer(messages) ?? "", /Validation failed/);
  });

  test("bash success is handed back with the exit code", async () => {
    const model = new ScriptedModel([
      call("bash", { command: "echo hi" }, "b1"),
      (history) => {
        const message = history.at(-1);
        assert.ok(message && message.role === "toolResult" && !message.isError);
        assert.match(toolText(history), /exit_code: 0/);
        assert.match(toolText(history), /hi/);
        return fauxAssistantMessage("ran");
      },
    ]);
    const messages = await runAgent([user("bash")], [bashTool], { model, cwd: dir });
    assert.equal(finalAnswer(messages), "ran");
  });

  test("a non-zero bash exit is a normal result, not a tool error", async () => {
    const model = new ScriptedModel([
      call("bash", { command: "echo no; echo bad >&2; exit 3" }, "b2"),
      (history) => {
        const message = history.at(-1);
        assert.ok(message && message.role === "toolResult" && message.isError === false);
        const text = toolText(history);
        assert.match(text, /exit_code: 3/);
        assert.match(text, /no/);
        assert.match(text, /bad/);
        return fauxAssistantMessage("saw the exit code");
      },
    ]);
    const messages = await runAgent([user("bash")], [bashTool], { model, cwd: dir });
    assert.equal(finalAnswer(messages), "saw the exit code");
  });
});
