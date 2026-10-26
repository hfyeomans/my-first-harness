import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message, UserMessage } from "@earendil-works/pi-ai";

export const SESSIONS_SUBDIR = path.join(".myagent", "sessions");

/** UTC `YYYYMMDD-HHMMSS-` plus 6 hex digits. No `.` or `/`, so it is always one name inside the sessions directory. */
export type SessionId = string & { readonly __brand: "SessionId" };

export type CompactionReason = "threshold" | "overflow";

export interface SessionEntry {
  readonly seq: number;
  readonly message: Message;
}

export interface Session {
  /** A new array: the newest summary, if any, then every live message. What the model sees next. */
  messages(): Message[];
  /** The live messages after the newest summary, oldest first. */
  entries(): readonly SessionEntry[];
  appendMessage(message: Message): Promise<void>;
  /** Replaces every live entry below `firstKept` with `summary`. `firstKept` must not be a tool result. */
  appendCompaction(input: { reason: CompactionReason; firstKept: number; summary: string }): Promise<void>;
}

export interface OpenedSession {
  id: SessionId;
  session: Session;
  /** Set when a torn last line was dropped. One line for stderr. */
  warning: string | undefined;
}

export interface NewSession {
  provider: string;
  model: string;
  cwd: string;
}

interface HeaderRecord extends NewSession {
  type: "session";
  version: 1;
  id: string;
  created_at: string;
}

interface MessageRecord {
  type: "message";
  seq: number;
  message: Message;
}

interface CompactionRecord {
  type: "compaction";
  reason: CompactionReason;
  first_kept: number;
  summary: UserMessage & { content: string };
}

type BodyRecord = MessageRecord | CompactionRecord;

interface Journal {
  readonly summary: UserMessage | undefined;
  readonly live: readonly SessionEntry[];
  readonly nextSeq: number;
}

const EMPTY: Journal = { summary: undefined, live: [], nextSeq: 1 };

export function parseSessionId(raw: string): SessionId | undefined {
  return /^\d{8}-\d{6}-[0-9a-f]{6}$/.test(raw) ? (raw as SessionId) : undefined;
}

/** A session that writes nothing. */
export function memorySession(): Session {
  return sessionOver(EMPTY, undefined);
}

export async function createSession(dir: string, info: NewSession): Promise<OpenedSession> {
  const now = new Date();
  const id = newSessionId(now);
  const file = sessionFile(dir, id);
  const header: HeaderRecord = { type: "session", version: 1, id, created_at: now.toISOString(), ...info };
  await mkdir(dir, { recursive: true });
  await writeFile(file, line(header), { flag: "wx" });
  return { id, session: sessionOver(EMPTY, file), warning: undefined };
}

/** Opens `id`, or the session written to most recently when `id` is absent. */
export async function resumeSession(dir: string, id?: SessionId): Promise<OpenedSession> {
  const target = id ?? (await latestSessionId(dir));
  const file = sessionFile(dir, target);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    if (isNotFound(err)) throw new Error(`No session ${target} in ${dir}.`);
    throw err;
  }

  const end = bytes.lastIndexOf(0x0a) + 1;
  const lines = bytes.subarray(0, end).toString("utf8").split("\n").slice(0, -1);
  const tail = bytes.subarray(end).toString("utf8");
  const tailIsRecord = tail !== "" && parsesAsJson(tail);
  if (tailIsRecord) lines.push(tail);
  const journal = foldLines(lines, file, target);

  // The next append must start on a fresh line, or it glues onto the tail and
  // becomes a bad middle line on the following resume.
  let warning: string | undefined;
  if (tailIsRecord) {
    await appendFile(file, "\n");
  } else if (tail !== "") {
    await truncate(file, end);
    warning = `warning: ${file} line ${lines.length + 1} was incomplete and was dropped.`;
  }
  return { id: target, session: sessionOver(journal, file), warning };
}

function sessionOver(initial: Journal, file: string | undefined): Session {
  let journal = initial;

  async function append(record: BodyRecord): Promise<void> {
    const next = fold(journal, record);
    if (file) await appendFile(file, line(record));
    journal = next;
  }

  return {
    messages: () => project(journal),
    entries: () => journal.live,
    appendMessage: (message) => append({ type: "message", seq: journal.nextSeq, message }),
    appendCompaction({ reason, firstKept, summary }) {
      // estimateContextTokens trusts a kept reply's usage when its timestamp is
      // at least the summary's, and that usage measured the old, longer prefix.
      const timestamp = Math.max(Date.now(), ...project(journal).map((message) => message.timestamp)) + 1;
      return append({
        type: "compaction",
        reason,
        first_kept: firstKept,
        summary: { role: "user", content: summary, timestamp },
      });
    },
  };
}

function project(journal: Journal): Message[] {
  const messages = journal.live.map((entry) => entry.message);
  return journal.summary ? [journal.summary, ...messages] : messages;
}

function fold(journal: Journal, record: BodyRecord): Journal {
  if (record.type === "message") {
    if (record.seq !== journal.nextSeq) {
      throw new Error(`expected message seq ${journal.nextSeq}, got ${record.seq}`);
    }
    return {
      ...journal,
      live: [...journal.live, { seq: record.seq, message: record.message }],
      nextSeq: record.seq + 1,
    };
  }
  const kept = journal.live.find((entry) => entry.seq === record.first_kept);
  if (!kept || kept.message.role === "toolResult") {
    throw new Error(`first_kept ${record.first_kept} is not a live message that starts a turn`);
  }
  return {
    ...journal,
    summary: record.summary,
    live: journal.live.filter((entry) => entry.seq >= record.first_kept),
  };
}

function foldLines(lines: readonly string[], file: string, id: SessionId): Journal {
  if (lines.length === 0) throw new Error(`${file}:1: missing session header`);
  let journal = EMPTY;
  for (const [index, text] of lines.entries()) {
    try {
      const record = parseRecord(text);
      if (index === 0) {
        if (record.type !== "session") throw new Error("line 1 must be the session header");
        if (record.id !== id) throw new Error(`session id ${record.id} does not match the file name`);
      } else if (record.type === "session") {
        throw new Error("only line 1 may be a session header");
      } else {
        journal = fold(journal, record);
      }
    } catch (err) {
      throw new Error(`${file}:${index + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return journal;
}

const ROLES = new Set(["system", "user", "assistant", "toolResult"]);

// Message bodies are checked only as far as role, content, and timestamp. This
// program is the only writer, and pi-ai owns the block shapes inside content.
function parseRecord(text: string): HeaderRecord | BodyRecord {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error("not a JSON object");
  switch (value["type"]) {
    case "session":
      if (value["version"] !== 1) throw new Error(`unsupported session version ${String(value["version"])}`);
      for (const key of ["id", "created_at", "provider", "model", "cwd"]) {
        if (typeof value[key] !== "string") throw new Error(`header ${key} must be a string`);
      }
      return value as unknown as HeaderRecord;
    case "message": {
      requireSeq(value["seq"], "seq");
      const message = value["message"];
      if (!isObject(message) || !ROLES.has(String(message["role"]))) throw new Error("message has no known role");
      if (typeof message["content"] !== "string" && !Array.isArray(message["content"])) {
        throw new Error("message content must be a string or an array");
      }
      if (typeof message["timestamp"] !== "number") throw new Error("message timestamp must be a number");
      return value as unknown as MessageRecord;
    }
    case "compaction": {
      if (value["reason"] !== "threshold" && value["reason"] !== "overflow") {
        throw new Error(`unknown compaction reason ${JSON.stringify(value["reason"])}`);
      }
      requireSeq(value["first_kept"], "first_kept");
      const summary = value["summary"];
      if (
        !isObject(summary) ||
        summary["role"] !== "user" ||
        typeof summary["content"] !== "string" ||
        typeof summary["timestamp"] !== "number"
      ) {
        throw new Error("summary must be a user message with string content");
      }
      return value as unknown as CompactionRecord;
    }
    default:
      throw new Error(`unknown record type ${JSON.stringify(value["type"])}`);
  }
}

function requireSeq(value: unknown, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

async function latestSessionId(dir: string): Promise<SessionId> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    names = [];
  }
  let latest: { id: SessionId; mtimeMs: number } | undefined;
  for (const name of names) {
    const id = name.endsWith(".jsonl") ? parseSessionId(name.slice(0, -".jsonl".length)) : undefined;
    if (!id) continue;
    const { mtimeMs } = await stat(path.join(dir, name));
    if (!latest || mtimeMs > latest.mtimeMs || (mtimeMs === latest.mtimeMs && id > latest.id)) {
      latest = { id, mtimeMs };
    }
  }
  if (!latest) throw new Error(`No sessions in ${dir}. Run without --resume to start one.`);
  return latest.id;
}

function newSessionId(now: Date): SessionId {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}` as SessionId;
}

function sessionFile(dir: string, id: SessionId): string {
  return path.join(dir, `${id}.jsonl`);
}

function line(record: HeaderRecord | BodyRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
