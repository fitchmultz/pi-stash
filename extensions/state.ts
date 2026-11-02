/**
 * Purpose: Pure helpers shared across the pi-stash extension modules.
 * Responsibilities: Validate persisted stash snapshots and untrusted values, cap stack growth, remove drafts, and create compact previews.
 * Scope: Stateless helpers only; no pi runtime, UI, or file access.
 * Usage: Imported by the extension entrypoint, picker, and unit tests.
 * Invariants/Assumptions: Drafts are stored newest-first and blank-draft filtering happens before stack mutation helpers run.
 */

export const MAX_STASHED_DRAFTS = 10;
export const STASH_ENTRY_TYPE = "pi-stash";

export interface PersistedEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export function isBlankDraft(text: string | undefined): boolean {
  return text === undefined || text.trim().length === 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function readDrafts(snapshot: unknown): string[] | undefined {
  if (!isRecord(snapshot) || !("drafts" in snapshot)) {
    return undefined;
  }
  const { drafts } = snapshot;
  return isStringArray(drafts) ? [...drafts] : undefined;
}

export function pushDraft(
  drafts: readonly string[],
  draft: string,
  limit = MAX_STASHED_DRAFTS,
): string[] {
  return [draft, ...drafts].slice(0, limit);
}

export function withoutDraft(drafts: readonly string[], draft: string): string[] {
  const index = drafts.indexOf(draft);
  return index < 0 ? [...drafts] : drafts.toSpliced(index, 1);
}

export function latestDraft(drafts: readonly string[]): string | undefined {
  return drafts.at(0);
}

export function clampSelectedIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, length - 1));
}

export function previewDraft(draft: string, maxLength = 72): string {
  const flattened = draft.replace(/\s+/g, " ").trim();
  if (flattened.length <= maxLength) {
    return flattened;
  }
  return `${flattened.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function hydrateState(entries: readonly PersistedEntry[]): string[] {
  for (const entry of entries.toReversed()) {
    if (entry.type !== "custom" || entry.customType !== STASH_ENTRY_TYPE) {
      continue;
    }
    const drafts = readDrafts(entry.data);
    if (drafts) {
      return drafts;
    }
  }

  return [];
}

export function countLabel(count: number): string {
  return count === 1 ? "1 draft" : `${count} drafts`;
}
