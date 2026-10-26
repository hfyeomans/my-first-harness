import { contentText, type Message } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { CompactionReason, Session, SessionEntry } from "./session.js";
import type { ModelContext } from "./types.js";

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
 * User text, assistant text, and tool-result text in that request are cut
 * until the estimate is under this share. The session file keeps the originals.
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
  const summary = await context.summarize({
    previous: previousText,
    replaced: capSummaryMessages(
      replaced.map((entry) => entry.message),
      context.window,
      previousText,
    ),
  });
  await session.appendCompaction({ reason, firstKept: firstKept.seq, summary });
  return true;
}

function capSummaryMessages(messages: readonly Message[], window: number, previous: string | undefined): Message[] {
  const budget = Math.max(1, Math.floor(window * SUMMARY_INPUT_RATIO));
  const previousTokens =
    previous === undefined ? 0 : estimateMessageTokens({ role: "user", content: previous, timestamp: 0 });
  const target = Math.max(1, budget - previousTokens);
  if (tokenSum(messages) <= target) return messages.slice();

  let cap = longestText(messages);
  let capped = messages.slice();
  while (tokenSum(capped) > target && cap > 1) {
    cap = Math.max(1, Math.floor(cap / 2));
    capped = messages.map((message) => capMessage(message, cap));
  }
  return capped;
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
      return message.content.flatMap((block) => (block.type === "text" ? [block.text.length] : []));
    case "user":
      if (typeof message.content === "string") return [message.content.length];
      return message.content.flatMap((block) => (block.type === "text" ? [block.text.length] : []));
    default:
      return [];
  }
}

function capMessage(message: Message, maxChars: number): Message {
  switch (message.role) {
    case "toolResult": {
      const text = contentText(message.content);
      if (text.length <= maxChars) return message;
      return { ...message, content: [{ type: "text", text: elideMiddle(text, maxChars) }] };
    }
    case "assistant":
      return {
        ...message,
        content: message.content.map((block) =>
          block.type === "text" && block.text.length > maxChars
            ? { ...block, text: elideMiddle(block.text, maxChars) }
            : block,
        ),
      };
    case "user":
      if (typeof message.content === "string") {
        if (message.content.length <= maxChars) return message;
        return { ...message, content: elideMiddle(message.content, maxChars) };
      }
      return {
        ...message,
        content: message.content.map((block) =>
          block.type === "text" && block.text.length > maxChars
            ? { ...block, text: elideMiddle(block.text, maxChars) }
            : block,
        ),
      };
    default:
      return message;
  }
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
