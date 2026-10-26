import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { runAgent } from "../src/loop.js";
import { finalAnswer } from "../src/messages.js";
import { piModel, loadPiModel, resolveCatalogModel } from "../src/pi-model.js";
import { readFileTool } from "../src/read-file.js";
import { agentTools } from "../src/registry.js";

test("piModel completes through the faux provider, including the tool result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "myagent-pi-"));
  try {
    await writeFile(path.join(dir, "note.txt"), "hello from note");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    assert.ok(model);

    faux.setResponses([
      (context) => {
        const tools = getCurrentTools(context.messages);
        assert.ok(tools.some((tool) => tool.name === "read_file"));
        const prompt = getCurrentSystemPrompt(context.messages);
        assert.match(prompt, /read_file/);
        assert.match(prompt, /write_file/);
        assert.match(prompt, /edit_file/);
        assert.match(prompt, /bash/);
        assert.match(prompt, /non-zero/);
        assert.match(prompt, /user's permissions/);
        return fauxAssistantMessage(
          [fauxToolCall("read_file", { path: "note.txt" }, { id: "call-1" })],
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const tool = [...context.messages].reverse().find((message) => message.role === "toolResult");
        assert.ok(tool && tool.role === "toolResult" && !tool.isError);
        let text = "";
        for (const block of tool.content) {
          if (block.type === "text") text += block.text;
        }
        assert.equal(text, "hello from note");
        return fauxAssistantMessage("the note says hello from note");
      },
    ]);

    const messages = await runAgent(
      [{ role: "user", content: "Read note.txt", timestamp: 1 }],
      [readFileTool],
      { model: piModel(models, model), cwd: dir },
    );

    assert.equal(faux.state.callCount, 2);
    assert.equal(finalAnswer(messages), "the note says hello from note");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piModel sends every registry tool as a declaration", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  faux.setResponses([
    (context) => {
      const tools = getCurrentTools(context.messages);
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["read_file", "write_file", "edit_file", "bash"],
      );
      const edit = tools.find((tool) => tool.name === "edit_file");
      assert.equal((edit?.parameters as { type?: string } | undefined)?.type, "object");
      assert.equal("run" in (edit ?? {}), false);
      return fauxAssistantMessage("done");
    },
  ]);

  const messages = await runAgent([{ role: "user", content: "hi", timestamp: 1 }], agentTools, {
    model: piModel(models, model),
  });
  assert.equal(finalAnswer(messages), "done");
});

test("claude-haiku-5-5 resolves for anthropic", async () => {
  const model = await loadPiModel("anthropic", "claude-haiku-5-5");
  assert.equal(typeof model.complete, "function");
});

test("older haiku, sonnet, and opus ids resolve to 5.5", () => {
  const models = builtinModels();
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-haiku-4-5").id, "claude-haiku-5-5");
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-haiku-4-5-20251001").id, "claude-haiku-5-5");
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-sonnet-4-5").id, "claude-sonnet-5-5");
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-sonnet-5").id, "claude-sonnet-5-5");
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-opus-4-8").id, "claude-opus-5-5");
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-opus-5").id, "claude-opus-5-5");
  assert.equal(
    resolveCatalogModel(models, "amazon-bedrock", "eu.anthropic.claude-opus-4-6-v1").id,
    "eu.anthropic.claude-opus-5-5",
  );
  assert.equal(
    resolveCatalogModel(models, "openrouter", "anthropic/claude-haiku-4.5:batch").id,
    "anthropic/claude-haiku-5.5:batch",
  );
  assert.equal(
    resolveCatalogModel(models, "vercel-ai-gateway", "anthropic/claude-opus-4.8-fast").id,
    "anthropic/claude-opus-5.5-fast",
  );
  assert.equal(
    resolveCatalogModel(models, "openrouter", "~anthropic/claude-sonnet-latest").id,
    "anthropic/claude-sonnet-5.5",
  );
  assert.equal(resolveCatalogModel(models, "github-copilot", "claude-haiku-4.5").id, "claude-haiku-5.5");
});

test("a 5.5 id stays on 5.5", () => {
  const models = builtinModels();
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-haiku-5-5").id, "claude-haiku-5-5");
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-sonnet-5-5").id, "claude-sonnet-5-5");
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-opus-5-5").id, "claude-opus-5-5");
  assert.equal(
    resolveCatalogModel(models, "openrouter", "anthropic/claude-haiku-5.5:batch").id,
    "anthropic/claude-haiku-5.5:batch",
  );
});

test("models outside haiku, sonnet, and opus are unchanged", () => {
  const models = builtinModels();
  assert.equal(resolveCatalogModel(models, "anthropic", "claude-fable-5").id, "claude-fable-5");
  assert.equal(resolveCatalogModel(models, "openai", "gpt-4o-mini").id, "gpt-4o-mini");
});

test("a route with no 5.5 model is refused", () => {
  const models = builtinModels();
  assert.throws(
    () => resolveCatalogModel(models, "amazon-bedrock", "in.anthropic.claude-haiku-4-5-20251001-v1:0"),
    /pinned to 5\.5/,
  );
});

test("an unknown model id is rejected before any request", async () => {
  await assert.rejects(
    () => loadPiModel("anthropic", "not-a-real-model"),
    /Unknown model "not-a-real-model" for provider "anthropic"/,
  );
});

test("piModel rejects an answer cut off at the output limit", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  assert.ok(model);
  faux.setResponses([fauxAssistantMessage("this answer was cut off", { stopReason: "length" })]);

  await assert.rejects(
    () =>
      runAgent([{ role: "user", content: "Write a long answer", timestamp: 1 }], [readFileTool], {
        model: piModel(models, model),
      }),
    /output limit/,
  );
  assert.equal(faux.state.callCount, 1);
});
