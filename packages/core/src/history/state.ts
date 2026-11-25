import type { HistoryEntry } from './log';

export interface HistoryState {
  /** Versions whose effect is currently in the files (not reverted by a live later version). */
  live: ReadonlySet<number>;
  /** Newest live original or redo version: what `undo` reverts. */
  undoTarget: HistoryEntry | undefined;
  /** Newest live undo version, unless new work was committed after it: what `redo` reverts. */
  redoTarget: HistoryEntry | undefined;
}

/**
 * A version is live unless a live, later version reverts it. A revert's depth is its target's
 * depth + 1: odd depths are undos, even depths above zero are redos, zero is original work.
 */
export function analyzeHistory(entries: readonly HistoryEntry[]): HistoryState {
  const depth = new Map<number, number>();
  for (const entry of entries) {
    const base = entry.revertOf === undefined ? -1 : (depth.get(entry.revertOf) ?? 0);
    depth.set(entry.version, base + 1);
  }

  const live = new Set<number>();
  const reverted = new Set<number>();
  let undoTarget: HistoryEntry | undefined;
  let redoTarget: HistoryEntry | undefined;
  let newerOriginalWork = false;

  for (const entry of [...entries].reverse()) {
    if (reverted.has(entry.version)) continue;
    live.add(entry.version);
    if (entry.revertOf !== undefined) reverted.add(entry.revertOf);

    const isUndo = (depth.get(entry.version) ?? 0) % 2 === 1;
    if (!isUndo && undoTarget === undefined) undoTarget = entry;
    if (isUndo && redoTarget === undefined && !newerOriginalWork) redoTarget = entry;
    if (entry.revertOf === undefined) newerOriginalWork = true;
  }
  return { live, undoTarget, redoTarget };
}
