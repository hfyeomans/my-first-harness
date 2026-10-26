import { contentText, type Message } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { CompactionReason, Session, SessionEntry } from "./session.js";
import type { ModelContext, SummaryInput } from "./types.js";

/**
 * Before the first reply reports usage, the estimate cannot see the system
 * prompt or the tool schemas, it guesses characters per token, and the reply
 * itself needs room. The last quarter of the window covers those.
 */
export const COMPACT_AT_RATIO = 0.75;

/** Leaves about half the window for new work before the next compaction. */
export const KEEP_RECENT_RATIO = 0.25;

/**
 * The summary request has to fit in the same window as the conversation.
 * User text, assistant text, tool-call argument strings, and tool-result
 * text in that request are cut until the estimate is under this share.
 * Strings that are already short can still add up, and so can the previous
 * summary. The copy then drops the oldest turns, or cuts that previous
 * summary the same way. The session file keeps the originals.
 */
const SUMMARY_INPUT_RATIO = 0.5;

/**
 * Replace older turns with one summary. `threshold` runs only when the
 * estimate passes `COMPACT_AT_RATIO`. `overflow` keeps only the newest group.
 * Returns false, having written nothing, when it did not compact.
 */
export async function compact(session: Session, context: ModelContext, reason: CompactionReason): Promise<boolean> {
  const messages = session.messages();
  if (reason === "threshold" && estimateContextTokens(messages).tokens <= context.window * COMPACT_AT_RATIO) {
    return false;
  }
  const keepTokens = reason === "threshold" ? context.window * KEEP_RECENT_RATIO : 0;

  const groups = turnGroups(session.entries());
  let keptTokens = 0;
  let keptGroups = 0;
  for (const group of groups.toReversed()) {
    // Per-message estimates: a kept reply's usage describes the old prefix.
    const tokens = group.reduce((sum, entry) => sum + estimateMessageTokens(entry.message), 0);
    if (keptGroups > 0 && keptTokens + tokens > keepTokens) break;
    keptTokens += tokens;
    keptGroups += 1;
  }
  const replaced = groups.slice(0, groups.length - keptGroups).flat();
  const firstKept = groups[groups.length - keptGroups]?.[0];
  if (replaced.length === 0 || !firstKept) return false;

  const previous = messages.length > session.entries().length ? messages[0] : undefined;
  const previousText = typeof previous?.content === "string" ? previous.content : undefined;
  const summary = await context.summarize(
    fitSummaryInput(
      replaced.map((entry) => entry.message),
      context.window,
      previousText,
    ),
  );
  await session.appendCompaction({ reason, firstKept: firstKept.seq, summary });
  return true;
}

function fitSummaryInput(messages: readonly Message[], window: number, previous: string | undefined): SummaryInput {
  const budget = Math.max(1, Math.floor(window * SUMMARY_INPUT_RATIO));
  const previousText =
    previous === undefined || tokensOfText(previous) <= budget ? previous : capTextToBudget(previous, budget);
  const target = budget - (previousText === undefined ? 0 : tokensOfText(previousText));

  let capped = messages.slice();
  if (tokenSum(capped) > target) {
    let cap = longestText(messages);
    while (tokenSum(capped) > target && cap > 1) {
      cap = Math.max(1, Math.floor(cap / 2));
      capped = messages.map((message) => capMessage(message, cap));
    }
    if (tokenSum(capped) > target) capped = dropOldest(capped, target);
  }
  return { previous: previousText, replaced: capped };
}

function tokensOfText(text: string): number {
  return estimateMessageTokens({ role: "user", content: text, timestamp: 0 });
}

// Halve from the original. The same cut as a long tool result or user message.
function capTextToBudget(text: string, budget: number): string {
  let cap = text.length;
  let capped = text;
  while (tokensOfText(capped) > budget && cap > 1) {
    cap = Math.max(1, Math.floor(cap / 2));
    capped = capString(text, cap);
  }
  return capped;
}

// Drop leading turns until the copy fits. A tool result stays with the call
// ahead of it, so the copy never starts on a result whose call was dropped.
function dropOldest(messages: readonly Message[], target: number): Message[] {
  let start = 0;
  while (start <= messages.length) {
    if (messages[start]?.role === "toolResult") {
      start += 1;
      continue;
    }
    const kept = messages.slice(start);
    const candidate = start === 0 ? kept : [omittedNote(start), ...kept];
    if (tokenSum(candidate) <= target) return candidate;
    start += 1;
  }
  return [];
}

function omittedNote(count: number): Message {
  return {
    role: "user",
    content: `[${count} earlier messages omitted from this summary input]`,
    timestamp: 0,
  };
}

function tokenSum(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function longestText(messages: readonly Message[]): number {
  let longest = 0;
  for (const message of messages) {
    for (const length of textLengths(message)) {
      if (length > longest) longest = length;
    }
  }
  return longest;
}

function textLengths(message: Message): number[] {
  switch (message.role) {
    case "toolResult":
      return [contentText(message.content).length];
    case "assistant":
      return message.content.flatMap((block) => {
        if (block.type === "text") return [block.text.length];
        if (block.type === "toolCall") return leafLengths(block.arguments);
        return [];
      });
    case "user":
      if (typeof message.content === "string") return [message.content.length];
      return message.content.flatMap((block) => (block.type === "text" ? [block.text.length] : []));
    default:
      return [];
  }
}

function leafLengths(value: unknown): number[] {
  if (typeof value === "string") return [value.length];
  if (Array.isArray(value)) return value.flatMap(leafLengths);
  if (isPlain(value)) return Object.values(value).flatMap(leafLengths);
  return [];
}

function capMessage(message: Message, maxChars: number): Message {
  switch (message.role) {
    case "toolResult": {
      const text = contentText(message.content);
      const capped = capString(text, maxChars);
      if (capped === text) return message;
      return { ...message, content: [{ type: "text", text: capped }] };
    }
    case "assistant":
      return {
        ...message,
        content: message.content.map((block) => {
          if (block.type === "text") {
            const text = capString(block.text, maxChars);
            return text === block.text ? block : { ...block, text };
          }
          if (block.type !== "toolCall") return block;
          const args = capLeaves(block.arguments, maxChars);
          return args === block.arguments ? block : { ...block, arguments: args as typeof block.arguments };
        }),
      };
    case "user":
      if (typeof message.content === "string") {
        const text = capString(message.content, maxChars);
        return text === message.content ? message : { ...message, content: text };
      }
      return {
        ...message,
        content: message.content.map((block) => {
          if (block.type !== "text") return block;
          const text = capString(block.text, maxChars);
          return text === block.text ? block : { ...block, text };
        }),
      };
    default:
      return message;
  }
}

function capString(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return elideMiddle(text, maxChars);
}

// Copies plain objects and arrays. Ids and names are not passed through here.
function capLeaves(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") return capString(value, maxChars);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const capped = capLeaves(item, maxChars);
      if (capped !== item) changed = true;
      return capped;
    });
    return changed ? next : value;
  }
  if (!isPlain(value)) return value;
  let changed = false;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const capped = capLeaves(child, maxChars);
    if (capped !== child) changed = true;
    copy[key] = capped;
  }
  return changed ? copy : value;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elideMiddle(text: string, maxChars: number): string {
  const markerFor = (omitted: string): string => `\n[... ${Buffer.byteLength(omitted)} bytes elided]\n`;
  const fullMarker = markerFor(text);
  if (fullMarker.length >= maxChars) return fullMarker.slice(0, maxChars);
  const room = maxChars - fullMarker.length;
  const headLen = Math.ceil(room / 2);
  const tailLen = Math.floor(room / 2);
  const omitted = text.slice(headLen, text.length - tailLen);
  return text.slice(0, headLen) + markerFor(omitted) + text.slice(text.length - tailLen);
}

// A group starts at every entry that is not a tool result, so a cut between
// groups never separates an assistant's tool calls from their results.
function turnGroups(entries: readonly SessionEntry[]): SessionEntry[][] {
  const groups: SessionEntry[][] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && entry.message.role === "toolResult") last.push(entry);
    else groups.push([entry]);
  }
  return groups;
}
