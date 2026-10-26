import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { createFauxModel } from "../src/faux-model.js";
import { runAgent } from "../src/loop.js";
import { finalAnswer } from "../src/messages.js";
import { agentTools } from "../src/registry.js";
import { createSession, resumeSession, type OpenedSession } from "../src/session.js";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function user(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}

async function workspace(): Promise<{ work: string; sessions: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "myagent-session-"));
  roots.push(root);
  const work = path.join(root, "work");
  await mkdir(work);
  await writeFile(path.join(work, "sample.txt"), "hello from disk\n");
  await writeFile(path.join(work, "big.txt"), "x".repeat(2_000));
  return { work, sessions: path.join(root, "sessions") };
}

async function readSample(
  work: string,
  sessions: string,
): Promise<{ opened: OpenedSession; messages: Message[]; file: string }> {
  const opened = await createSession(sessions, { provider: "faux", model: "", cwd: work });
  const messages = await runAgent([user("Read sample.txt")], agentTools, {
    model: createFauxModel(),
    cwd: work,
    session: opened.session,
  });
  return { opened, messages, file: path.join(sessions, `${opened.id}.jsonl`) };
}

async function askAgain(work: string, opened: OpenedSession): Promise<Message[]> {
  return runAgent([user("What did I ask before?")], agentTools, {
    model: createFauxModel(),
    cwd: work,
    session: opened.session,
  });
}

test("a new session directory is 0700 and the file is 0600", async () => {
  const { sessions } = await workspace();
  const opened = await createSession(sessions, { provider: "faux", model: "", cwd: "" });
  assert.equal((await stat(sessions)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(sessions, `${opened.id}.jsonl`))).mode & 0o777, 0o600);
});

test("resume continues a faux conversation", async () => {
  const { work, sessions } = await workspace();
  const opened = await createSession(sessions, { provider: "faux", model: "", cwd: work });
  const history = [user("Read sample.txt")];
  const before = structuredClone(history);
  const first = await runAgent(history, agentTools, { model: createFauxModel(), cwd: work, session: opened.session });
  assert.deepEqual(history, before);

  const resumed = await resumeSession(sessions);
  assert.equal(resumed.id, opened.id);
  assert.equal(resumed.warning, undefined);
  assert.deepEqual(resumed.session.messages(), first);

  const second = await askAgain(work, resumed);
  assert.equal(finalAnswer(second), "Earlier you asked: Read sample.txt");
});

test("a truncated last line is dropped with a warning and the session continues", async () => {
  const { work, sessions } = await workspace();
  const { opened, messages, file } = await readSample(work, sessions);
  const lineCount = (await readFile(file, "utf8")).split("\n").length - 1;
  await appendFile(file, '{"type":"message","seq":5,"mess');

  const resumed = await resumeSession(sessions, opened.id);
  assert.match(resumed.warning ?? "", new RegExp(`line ${lineCount + 1} was incomplete`));
  assert.deepEqual(resumed.session.messages(), messages);

  const second = await askAgain(work, resumed);
  assert.equal(finalAnswer(second), "Earlier you asked: Read sample.txt");

  const again = await resumeSession(sessions, opened.id);
  assert.equal(again.warning, undefined, "the torn bytes were cut off the file");
  assert.deepEqual(again.session.messages(), second);
});

test("a last record missing only its newline is kept", async () => {
  const { work, sessions } = await workspace();
  const { opened, messages, file } = await readSample(work, sessions);
  await writeFile(file, (await readFile(file, "utf8")).slice(0, -1));

  const resumed = await resumeSession(sessions, opened.id);
  assert.equal(resumed.warning, undefined);
  assert.deepEqual(resumed.session.messages(), messages);

  const second = await askAgain(work, resumed);
  const again = await resumeSession(sessions, opened.id);
  assert.deepEqual(again.session.messages(), second);
});

test("a bad middle line fails the resume with the file name and line number", async () => {
  const { work, sessions } = await workspace();
  const { opened, file } = await readSample(work, sessions);
  const lines = (await readFile(file, "utf8")).split("\n");

  await writeFile(file, lines.map((text, index) => (index === 2 ? "not json" : text)).join("\n"));
  await assert.rejects(resumeSession(sessions, opened.id), (err: Error) => err.message.startsWith(`${file}:3: `));

  await writeFile(file, [...lines.slice(0, 3), lines[2], ...lines.slice(3)].join("\n"));
  await assert.rejects(resumeSession(sessions, opened.id), (err: Error) => err.message.startsWith(`${file}:4: `));
});

test("resume after compaction rebuilds the compacted history", async () => {
  const { work, sessions } = await workspace();
  const opened = await createSession(sessions, { provider: "faux", model: "", cwd: work });
  const first = await runAgent([user("Read big.txt")], agentTools, {
    model: createFauxModel({ contextWindow: 40 }),
    cwd: work,
    session: opened.session,
  });
  assert.equal(first[0]?.role, "user");
  assert.equal(first[0]?.content, "Read big.txt\n(faux summary of 1 earlier message)");
  assert.match(finalAnswer(first) ?? "", /^The file says:\nx{2000}$/);

  const resumed = await resumeSession(sessions, opened.id);
  assert.deepEqual(resumed.session.messages(), first);

  const second = await runAgent([user("What did I ask before?")], agentTools, {
    model: createFauxModel({ contextWindow: 40 }),
    cwd: work,
    session: resumed.session,
  });
  assert.match(finalAnswer(second) ?? "", /^Earlier you asked: Read big\.txt\n\(faux summary/);
  assert.ok(second.some((message) => message.role === "user" && message.content === "What did I ask before?"));

  const again = await resumeSession(sessions, opened.id);
  assert.deepEqual(again.session.messages(), second);
});
