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
import { runAgent } from "../src/loop.js";
import { finalAnswer } from "../src/messages.js";
import { piModel } from "../src/pi-model.js";
import { readFileTool } from "../src/read-file.js";

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
        assert.match(getCurrentSystemPrompt(context.messages), /read_file/);
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
