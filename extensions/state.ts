/**
 * Purpose: Pure helpers for managing the pi-stash draft stack.
 * Responsibilities: Validate persisted stash snapshots, cap stack growth, remove drafts by index, and create compact previews.
 * Scope: Stateless draft-stack logic only; no pi runtime or UI access.
 * Usage: Imported by the extension entrypoint and unit tests.
 * Invariants/Assumptions: Drafts are stored newest-first, blank-draft filtering happens before stack mutation helpers run, and snapshots are append-only.
 */

export const MAX_STASHED_DRAFTS = 10;
export const STASH_ENTRY_TYPE = "pi-stash";

export interface StashState {
	drafts: string[];
}

export interface PersistedEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

interface StashSnapshot {
	drafts?: unknown;
}

export interface RemoveDraftResult {
	draft: string | undefined;
	remaining: string[];
	nextIndex: number;
}

export function isBlankDraft(text: string | undefined): boolean {
	return text === undefined || text.trim().length === 0;
}

export function pushDraft(drafts: readonly string[], draft: string, limit = MAX_STASHED_DRAFTS): string[] {
	return [draft, ...drafts].slice(0, limit);
}

export function clampSelectedIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

export function removeDraftAt(drafts: readonly string[], index: number): RemoveDraftResult {
	if (index < 0 || index >= drafts.length) {
		return {
			draft: undefined,
			remaining: [...drafts],
			nextIndex: clampSelectedIndex(index, drafts.length),
		};
	}

	const remaining = drafts.filter((_, currentIndex) => currentIndex !== index);
	return {
		draft: drafts[index],
		remaining,
		nextIndex: clampSelectedIndex(index, remaining.length),
	};
}

export function previewDraft(draft: string, maxLength = 72): string {
	const flattened = draft.replace(/\s+/g, " ").trim();
	if (flattened.length <= maxLength) return flattened;
	return `${flattened.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function hydrateState(entries: readonly PersistedEntry[]): StashState {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== STASH_ENTRY_TYPE) continue;
		const snapshot = entry.data as StashSnapshot | undefined;
		if (!snapshot || !Array.isArray(snapshot.drafts)) continue;
		if (!snapshot.drafts.every((draft) => typeof draft === "string")) continue;
		return { drafts: [...snapshot.drafts] };
	}

	return { drafts: [] };
}

export function countLabel(count: number): string {
	return count === 1 ? "1 draft" : `${count} drafts`;
}
