import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { runAgent } from "../src/loop.js";
import { finalAnswer } from "../src/messages.js";
import { readFileTool } from "../src/read-file.js";
import type { AgentModel, Tool } from "../src/types.js";

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

function readCall(id: string, file: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall("read_file", { path: file }, { id })], {
    stopReason: "toolUse",
  });
}

function toolError(history: readonly Message[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.role !== "toolResult") continue;
    if (!message.isError) throw new Error("expected a tool error");
    let text = "";
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
    }
    return text;
  }
  throw new Error("expected a tool result");
}

describe("runAgent", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "myagent-loop-"));
    await writeFile(path.join(dir, "hello.txt"), "hello from disk\n");
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns a plain answer with no tool call", async () => {
    const history = [user("Say hello")];
    const model = new ScriptedModel([fauxAssistantMessage("hello")]);
    const seen: ToolCall[] = [];
    const messages = await runAgent(history, [readFileTool], {
      model,
      cwd: dir,
      onToolCall: (call) => seen.push(call),
    });

    assert.equal(history.length, 1);
    assert.equal(model.calls, 1);
    assert.deepEqual(seen, []);
    assert.equal(messages.length, 2);
    assert.equal(finalAnswer(messages), "hello");
  });

  test("runs one tool call and then returns the model's answer", async () => {
    const model = new ScriptedModel([
      readCall("c1", "hello.txt"),
      (history) => {
        const tool = history.at(-1);
        assert.ok(tool && tool.role === "toolResult" && !tool.isError);
        let text = "";
        for (const block of tool.content) {
          if (block.type === "text") text += block.text;
        }
        assert.equal(text, "hello from disk\n");
        return fauxAssistantMessage("the file says hello from disk");
      },
    ]);

    const seen: string[] = [];
    const messages = await runAgent([user("Read hello.txt")], [readFileTool], {
      model,
      cwd: dir,
      onToolCall: (call) => seen.push(call.name),
    });

    assert.equal(model.calls, 2);
    assert.deepEqual(seen, ["read_file"]);
    assert.equal(messages.length, 4);
    assert.equal(messages[2]?.role, "toolResult");
    assert.equal(finalAnswer(messages), "the file says hello from disk");
  });

  test("gives a tool error back to the model, which then answers", async () => {
    const model = new ScriptedModel([
      readCall("c1", "missing.txt"),
      (history) => fauxAssistantMessage(`recovered: ${toolError(history)}`),
    ]);

    const messages = await runAgent([user("Read missing.txt")], [readFileTool], {
      model,
      cwd: dir,
    });

    assert.equal(model.calls, 2);
    const tool = messages[2];
    assert.ok(tool && tool.role === "toolResult" && tool.isError);
    assert.match(finalAnswer(messages) ?? "", /recovered: No such file: missing\.txt/);
  });

  test("stops after maxTurns model calls", async () => {
    const model = new ScriptedModel([
      readCall("c1", "hello.txt"),
      readCall("c2", "hello.txt"),
      fauxAssistantMessage("should not run"),
    ]);

    const messages = await runAgent([user("keep reading")], [readFileTool], {
      model,
      cwd: dir,
      maxTurns: 2,
    });

    assert.equal(model.calls, 2);
    assert.equal(messages.length, 5);
    assert.equal(messages.at(-1)?.role, "toolResult");
    assert.equal(finalAnswer(messages), undefined);
  });

  test("reports an unknown tool instead of throwing", async () => {
    const model = new ScriptedModel([
      fauxAssistantMessage([fauxToolCall("nope", {}, { id: "u1" })], { stopReason: "toolUse" }),
      (history) => fauxAssistantMessage(`recovered: ${toolError(history)}`),
    ]);

    const messages = await runAgent([user("go")], [readFileTool], { model, cwd: dir });
    assert.match(finalAnswer(messages) ?? "", /Unknown tool: nope/);
  });

  test("reports a thrown tool error instead of throwing", async () => {
    const boom: Tool<Record<string, never>> = {
      name: "boom",
      description: "always throws",
      parameters: Type.Object({}),
      parse() {
        return {};
      },
      run() {
        return Promise.reject(new Error("disk on fire"));
      },
    };
    const model = new ScriptedModel([
      fauxAssistantMessage([fauxToolCall("boom", {}, { id: "b1" })], { stopReason: "toolUse" }),
      (history) => fauxAssistantMessage(`recovered: ${toolError(history)}`),
    ]);

    const messages = await runAgent([user("go")], [boom], { model, cwd: dir });
    assert.equal(finalAnswer(messages), "recovered: disk on fire");
  });

  test("reports invalid tool arguments instead of throwing", async () => {
    const model = new ScriptedModel([
      fauxAssistantMessage([fauxToolCall("read_file", {}, { id: "bad" })], {
        stopReason: "toolUse",
      }),
      (history) => fauxAssistantMessage(`recovered: ${toolError(history)}`),
    ]);

    const messages = await runAgent([user("go")], [readFileTool], { model, cwd: dir });
    assert.match(finalAnswer(messages) ?? "", /Validation failed/);
  });
});
