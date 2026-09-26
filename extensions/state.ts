/**
 * Purpose: Pure helpers for managing the pi-stash draft stack.
 * Responsibilities: Validate persisted stash snapshots, cap stack growth, remove drafts, and create compact previews.
 * Scope: Stateless draft-stack logic only; no pi runtime, UI, or file access.
 * Usage: Imported by the extension entrypoint and unit tests.
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

export function readDrafts(snapshot: unknown): string[] | undefined {
	const drafts = (snapshot as { drafts?: unknown } | undefined)?.drafts;
	return Array.isArray(drafts) && drafts.every((draft) => typeof draft === "string") ? [...drafts] : undefined;
}

export function pushDraft(drafts: readonly string[], draft: string, limit = MAX_STASHED_DRAFTS): string[] {
	return [draft, ...drafts].slice(0, limit);
}

export function withoutDraft(drafts: readonly string[], draft: string): string[] {
	const index = drafts.indexOf(draft);
	return index < 0 ? [...drafts] : drafts.toSpliced(index, 1);
}

export function clampSelectedIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

export function previewDraft(draft: string, maxLength = 72): string {
	const flattened = draft.replace(/\s+/g, " ").trim();
	if (flattened.length <= maxLength) return flattened;
	return `${flattened.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function hydrateState(entries: readonly PersistedEntry[]): string[] {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== STASH_ENTRY_TYPE) continue;
		const drafts = readDrafts(entry.data);
		if (drafts) return drafts;
	}

	return [];
}

export function countLabel(count: number): string {
	return count === 1 ? "1 draft" : `${count} drafts`;
}
