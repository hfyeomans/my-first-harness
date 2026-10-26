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
  const summary = await context.summarize({
    previous: typeof previous?.content === "string" ? previous.content : undefined,
    replaced: replaced.map((entry) => entry.message),
  });
  await session.appendCompaction({ reason, firstKept: firstKept.seq, summary });
  return true;
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
