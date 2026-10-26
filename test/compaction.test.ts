import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { contentText, fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createFauxModel } from "../src/faux-model.js";
import { runAgent } from "../src/loop.js";
import { finalAnswer, toolCallsOf, toolResultMessage } from "../src/messages.js";
import { readFileTool } from "../src/read-file.js";
import { agentTools } from "../src/registry.js";
import { createSession, resumeSession } from "../src/session.js";
import type { AgentModel, SummaryInput } from "../src/types.js";

function user(content: string): Message {
  return { role: "user", content, timestamp: 1 };
}

function scripted(
  steps: AssistantMessage[],
  window: number,
): { model: AgentModel; calls: () => number; summaries: SummaryInput[] } {
  let calls = 0;
  const summaries: SummaryInput[] = [];
  const model: AgentModel = {
    async complete() {
      const step = steps[calls];
      calls += 1;
      if (!step) throw new Error(`model called ${calls} times; script has ${steps.length}`);
      return step;
    },
    context: {
      window,
      async summarize(input) {
        summaries.push(input);
        return `summary ${summaries.length}`;
      },
    },
  };
  return { model, calls: () => calls, summaries };
}

const overflow = fauxAssistantMessage([], {
  stopReason: "error",
  errorMessage: "prompt is too long: 201234 tokens > 200000 maximum",
});

describe("compaction", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "myagent-compaction-"));
    await writeFile(path.join(dir, "a.txt"), "a".repeat(200));
    await writeFile(path.join(dir, "b.txt"), "b".repeat(200));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a tiny faux window compacts and the edit still completes", async () => {
    await writeFile(path.join(dir, "sample.txt"), "hello from disk\n");
    const prompt = 'Edit sample.txt, replace "hello" with "goodbye", and verify';
    const seen: string[] = [];
    const messages = await runAgent([user(prompt)], agentTools, {
      model: createFauxModel({ contextWindow: 40 }),
      cwd: dir,
      onToolCall: (call) => seen.push(call.name),
    });

    assert.deepEqual(seen, ["read_file", "edit_file", "bash"]);
    assert.equal(messages[0]?.role, "user");
    assert.match(String(messages[0]?.content), new RegExp(`^${prompt}\\n\\(faux summary of \\d+ earlier messages?\\)$`));
    assert.match(finalAnswer(messages) ?? "", /^Updated sample\.txt\.\nexit_code: 0/);
    assert.equal(await readFile(path.join(dir, "sample.txt"), "utf8"), "goodbye from disk\n");
  });

  test("an assistant message stays immediately followed by all of its tool results", async () => {
    const { model, calls, summaries } = scripted(
      [
        fauxAssistantMessage(
          [
            fauxToolCall("read_file", { path: "a.txt" }, { id: "c1" }),
            fauxToolCall("read_file", { path: "b.txt" }, { id: "c2" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ],
      60,
    );

    const messages = await runAgent([user("Read a.txt and b.txt")], [readFileTool], { model, cwd: dir });

    assert.equal(calls(), 2);
    assert.deepEqual(
      summaries.map((input) => input.replaced.map((message) => message.role)),
      [["user"]],
    );
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "toolResult", "toolResult", "assistant"],
    );
    assert.equal(messages[0]?.content, "summary 1");
    const call = messages[1];
    assert.ok(call?.role === "assistant");
    assert.deepEqual(
      toolCallsOf(call).map((block) => block.id),
      messages.slice(2, 4).map((message) => (message.role === "toolResult" ? message.toolCallId : "")),
    );
    assert.equal(finalAnswer(messages), "done");
  });

  test("a kept reply's old usage does not trigger another compaction", async () => {
    const usage = { ...fauxAssistantMessage("").usage, totalTokens: 90 };
    const stale = { ...fauxAssistantMessage("ok", { timestamp: Date.now() + 60_000 }), usage };
    const { model, summaries } = scripted(
      [
        fauxAssistantMessage([fauxToolCall("read_file", { path: "missing.txt" }, { id: "r1" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ],
      100,
    );
    const history = [user("x".repeat(350)), stale, user("n".repeat(80))];

    const messages = await runAgent(history, [readFileTool], { model, cwd: dir });

    assert.equal(summaries.length, 1);
    assert.ok(messages.includes(stale), "the reply with the old usage is still in history");
    assert.equal(finalAnswer(messages), "done");
  });

  test("an overflow compacts, retries once, and does not use a turn", async () => {
    const { model, calls, summaries } = scripted([overflow, fauxAssistantMessage("answer")], 200_000);
    const history = [user("first"), fauxAssistantMessage("first answer"), user("second")];

    const messages = await runAgent(history, [readFileTool], { model, cwd: dir, maxTurns: 1 });

    assert.equal(calls(), 2);
    assert.equal(finalAnswer(messages), "answer");
    assert.deepEqual(
      summaries.map((input) => input.replaced.length),
      [2],
    );
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "user", "assistant"],
    );
    assert.ok(!messages.some((message) => message.role === "assistant" && message.stopReason === "error"));
  });

  test("a second overflow fails without a third call", async () => {
    const { model, calls } = scripted([overflow, overflow, fauxAssistantMessage("never")], 200_000);
    const history = [user("first"), fauxAssistantMessage("first answer"), user("second")];

    await assert.rejects(
      runAgent(history, [readFileTool], { model, cwd: dir }),
      /does not fit in the model's context window/,
    );
    assert.equal(calls(), 2);
  });

  test("an overflow with nothing older to summarize fails after one call", async () => {
    const sessions = await mkdtemp(path.join(tmpdir(), "myagent-overflow-"));
    try {
      const { model, calls, summaries } = scripted([overflow, fauxAssistantMessage("never")], 200_000);
      const opened = await createSession(sessions, { provider: "faux", model: "", cwd: dir });

      await assert.rejects(
        runAgent([user("only")], [readFileTool], { model, cwd: dir, session: opened.session }),
        /does not fit in the model's context window/,
      );
      assert.equal(calls(), 1);
      assert.equal(summaries.length, 0);
      const resumed = await resumeSession(sessions, opened.id);
      assert.deepEqual(
        resumed.session.messages().map((message) => message.role),
        ["user"],
      );
    } finally {
      await rm(sessions, { recursive: true, force: true });
    }
  });

  test("a tiny faux window compacts an oversized tool result and resume rebuilds history", async () => {
    const sessions = path.join(dir, "sessions-huge");
    await mkdir(sessions);
    const window = 200;
    const huge = "H".repeat(200_000);
    const dropped = fauxToolCall("read_file", { path: "big.txt" }, { id: "faux-1" });
    const opened = await createSession(sessions, { provider: "faux", model: "faux", cwd: dir });
    const faux = createFauxModel({ contextWindow: window });
    const model: AgentModel = {
      complete: (history, tools) => faux.complete(history, tools),
      context: {
        window,
        async summarize(input) {
          const tokens = estimateContextTokens(input.replaced).tokens;
          if (tokens > window) {
            throw new Error("Compaction failed. The conversation does not fit in the model's context window.");
          }
          const result = input.replaced.find((message) => message.role === "toolResult");
          assert.ok(result);
          const text = contentText(result.content);
          assert.match(text, /\[\.\.\. \d+ bytes elided\]/);
          assert.ok(text.length < huge.length);
          return faux.context!.summarize(input);
        },
      },
    };

    const messages = await runAgent(
      [
        user("Read big.txt"),
        fauxAssistantMessage([dropped], { stopReason: "toolUse", timestamp: 2 }),
        toolResultMessage(dropped, { ok: true, output: huge }),
        user("What did I ask before?"),
      ],
      agentTools,
      { model, cwd: dir, session: opened.session },
    );

    assert.match(finalAnswer(messages) ?? "", /^Earlier you asked: Read big\.txt\n\(faux summary/);
    assert.equal(JSON.stringify(messages).includes(huge), false);
    const file = await readFile(path.join(sessions, `${opened.id}.jsonl`), "utf8");
    assert.equal(file.includes(huge), true);
    const resumed = await resumeSession(sessions, opened.id);
    assert.deepEqual(resumed.session.messages(), messages);
  });

  test("a new faux tool call id does not reuse a kept id after compaction", async () => {
    const kept = fauxToolCall("read_file", { path: "kept.txt" }, { id: "faux-2" });
    const dropped = fauxToolCall("read_file", { path: "big.txt" }, { id: "faux-1" });
    await writeFile(path.join(dir, "other.txt"), "hi\n");
    const seen: string[] = [];

    const messages = await runAgent(
      [
        user("Read big.txt"),
        fauxAssistantMessage([dropped], { stopReason: "toolUse", timestamp: 2 }),
        toolResultMessage(dropped, { ok: true, output: "H".repeat(20_000) }),
        fauxAssistantMessage([kept], { stopReason: "toolUse", timestamp: 4 }),
        toolResultMessage(kept, { ok: true, output: "kept" }),
        user("Read other.txt"),
      ],
      agentTools,
      {
        model: createFauxModel({ contextWindow: 2_000 }),
        cwd: dir,
        onToolCall: (call) => seen.push(call.id),
      },
    );

    assert.deepEqual(seen, ["faux-3"]);
    const ids = messages.flatMap((message) =>
      message.role === "assistant" ? toolCallsOf(message).map((call) => call.id) : [],
    );
    assert.ok(ids.includes("faux-2"));
    assert.equal(new Set(ids).size, ids.length);
  });
});
