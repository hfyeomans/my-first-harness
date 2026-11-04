import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTools, findTool, toolDeclarations } from "../src/registry.js";

test("the registry is the five tools, looked up by name", () => {
  const names = agentTools.map((tool) => tool.name);
  assert.deepEqual(names, ["read_file", "write_file", "edit_file", "bash", "remember"]);
  assert.equal(new Set(names).size, names.length);
  assert.equal(findTool(agentTools, "edit_file")?.name, "edit_file");
  assert.equal(findTool(agentTools, "nope"), undefined);
  assert.equal(findTool([agentTools[3]!], "read_file"), undefined);
});

test("declarations are the pi-ai schema, without parse or run", () => {
  const declarations = toolDeclarations(agentTools);
  assert.deepEqual(
    declarations.map((tool) => tool.name),
    ["read_file", "write_file", "edit_file", "bash", "remember"],
  );
  for (const tool of declarations) {
    assert.equal("run" in tool, false);
    assert.equal("parse" in tool, false);
    assert.equal(typeof tool.description, "string");
    assert.equal((tool.parameters as { type?: string }).type, "object");
    assert.equal(Object.getOwnPropertySymbols(tool.parameters).length, 0);
  }

  const required = (name: string): string[] => {
    const tool = declarations.find((candidate) => candidate.name === name);
    assert.ok(tool);
    const schema = tool.parameters as { required?: string[] };
    assert.ok(schema.required);
    return schema.required;
  };
  assert.deepEqual(required("read_file"), ["path"]);
  assert.deepEqual(required("write_file"), ["path", "content"]);
  assert.deepEqual(required("edit_file"), ["path", "old_string", "new_string"]);
  assert.deepEqual(required("bash"), ["command"]);
  assert.deepEqual(required("remember"), ["note"]);
});
