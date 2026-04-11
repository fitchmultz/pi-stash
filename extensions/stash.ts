/**
 * Purpose: Add fast stash-and-restore draft workflow to the pi editor.
 * Responsibilities: Capture editor drafts, restore them later, persist stash state, and expose shortcuts and picker-based stash management.
 * Scope: Interactive editor draft management for a single pi session.
 * Usage: Install as a pi package, then use Ctrl+Shift+S to stash and Ctrl+Shift+R to restore or pick from multiple drafts.
 * Invariants/Assumptions: Drafts are restored newest-first by default, blank drafts are never stashed, and degraded clients fall back to confirmation or summary flows instead of crashing.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import {
	clampSelectedIndex,
	countLabel,
	hydrateState,
	isBlankDraft,
	MAX_STASHED_DRAFTS,
	previewDraft,
	pushDraft,
	removeDraftAt,
	STASH_ENTRY_TYPE,
} from "./state.ts";

interface DraftPickerResultRestore {
	action: "restore";
	index: number;
}

interface DraftPickerResultDelete {
	action: "delete";
	index: number;
}

interface DraftPickerResultClear {
	action: "clear";
}

interface DraftPickerResultCancel {
	action: "cancel";
}

interface DraftPickerResultUnsupported {
	action: "unsupported";
}

type DraftPickerResult =
	| DraftPickerResultRestore
	| DraftPickerResultDelete
	| DraftPickerResultClear
	| DraftPickerResultCancel
	| DraftPickerResultUnsupported;

function getThemeForeground(ctx: ExtensionContext): ((name: string, value: string) => string) | undefined {
	const theme = ctx.ui.theme as { fg?: (name: string, value: string) => string } | undefined;
	return typeof theme?.fg === "function" ? theme.fg.bind(theme) : undefined;
}

function formatStatusText(ctx: ExtensionContext, text: string): string {
	return getThemeForeground(ctx)?.("accent", text) ?? text;
}

function requiresReplaceConfirmation(ctx: ExtensionContext): boolean {
	return getThemeForeground(ctx) === undefined;
}

function updateStatus(ctx: ExtensionContext, drafts: readonly string[]): void {
	if (drafts.length === 0) {
		ctx.ui.setStatus("pi-stash", undefined);
		return;
	}

	ctx.ui.setStatus("pi-stash", formatStatusText(ctx, `📦 ${countLabel(drafts.length)}`));
}

function persistState(pi: ExtensionAPI, drafts: readonly string[]): void {
	pi.appendEntry(STASH_ENTRY_TYPE, { drafts: [...drafts] });
}

function ensureEditor(ctx: ExtensionContext, action: string): boolean {
	if (ctx.hasUI) return true;
	ctx.ui.notify(`${action} requires the interactive editor`, "warning");
	return false;
}

function stashDraft(pi: ExtensionAPI, ctx: ExtensionContext, drafts: readonly string[], draft: string): string[] {
	const nextDrafts = pushDraft(drafts, draft, MAX_STASHED_DRAFTS);
	persistState(pi, nextDrafts);
	updateStatus(ctx, nextDrafts);

	const suffix = drafts.length >= MAX_STASHED_DRAFTS ? " Oldest draft dropped." : "";
	ctx.ui.notify(`Stashed ${countLabel(nextDrafts.length)}: ${previewDraft(draft)}${suffix}`, "info");
	return nextDrafts;
}

function stashEditor(pi: ExtensionAPI, ctx: ExtensionContext, drafts: readonly string[]): string[] {
	if (!ensureEditor(ctx, "Stashing")) return [...drafts];

	const draft = ctx.ui.getEditorText();
	if (isBlankDraft(draft)) {
		ctx.ui.notify("Nothing to stash", "warning");
		return [...drafts];
	}

	ctx.ui.setEditorText("");
	return stashDraft(pi, ctx, drafts, draft);
}

function insertDraftIntoEditor(ctx: ExtensionContext, draft: string): void {
	if (isBlankDraft(ctx.ui.getEditorText())) {
		ctx.ui.setEditorText(draft);
		return;
	}

	ctx.ui.pasteToEditor(draft);
}

async function restoreDraftAt(pi: ExtensionAPI, ctx: ExtensionContext, drafts: readonly string[], index: number): Promise<string[]> {
	if (!ensureEditor(ctx, "Restoring")) return [...drafts];

	const { draft, remaining } = removeDraftAt(drafts, index);
	if (!draft) {
		ctx.ui.notify("No stashed draft at that position", "warning");
		return [...drafts];
	}

	if (requiresReplaceConfirmation(ctx)) {
		const confirmed = await ctx.ui.confirm(
			"Replace editor with stashed draft?",
			"This client cannot safely merge stashed drafts with existing editor text. Restoring will replace the current editor contents.",
		);
		if (!confirmed) {
			ctx.ui.notify("Restore cancelled", "info");
			return [...drafts];
		}

		ctx.ui.setEditorText(draft);
	} else {
		insertDraftIntoEditor(ctx, draft);
	}
	persistState(pi, remaining);
	updateStatus(ctx, remaining);
	ctx.ui.notify(`Restored draft: ${previewDraft(draft)}`, "info");
	return remaining;
}

function clearDrafts(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
	persistState(pi, []);
	updateStatus(ctx, []);
	ctx.ui.notify("Cleared stashed drafts", "info");
	return [];
}

function summarizeDrafts(drafts: readonly string[]): string {
	return drafts.map((draft, index) => `${index + 1}. ${previewDraft(draft, 64)}`).join("\n");
}

function buildDraftItems(drafts: readonly string[]): SelectItem[] {
	return drafts.map((draft, index) => {
		const lineCount = draft.split(/\r?\n/).length;
		const latestLabel = index === 0 ? " • latest" : "";
		return {
			value: `${index}`,
			label: `${index + 1}. ${previewDraft(draft, 64)}`,
			description: `${lineCount} line${lineCount === 1 ? "" : "s"} • ${draft.length} chars${latestLabel}`,
		};
	});
}

async function showDraftPicker(
	ctx: ExtensionContext,
	drafts: readonly string[],
	selectedIndex: number,
): Promise<DraftPickerResult> {
	const items = buildDraftItems(drafts);

	const result = await ctx.ui.custom<DraftPickerResult>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Stashed Drafts (${drafts.length})`))));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.setSelectedIndex(clampSelectedIndex(selectedIndex, items.length));
		selectList.onSelect = (item) => done({ action: "restore", index: Number(item.value) });
		selectList.onCancel = () => done({ action: "cancel" });
		container.addChild(selectList);

		container.addChild(
			new Text(
				theme.fg(
					"dim",
					[
						rawKeyHint("up/down", "navigate"),
						rawKeyHint("enter", "restore"),
						rawKeyHint("ctrl+d", "delete"),
						rawKeyHint("ctrl+x", "clear all"),
						rawKeyHint("esc", "cancel"),
					].join(" • "),
				),
			),
		);
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.ctrl("d"))) {
					const selected = selectList.getSelectedItem();
					if (selected) done({ action: "delete", index: Number(selected.value) });
					return;
				}

				if (matchesKey(data, Key.ctrl("x"))) {
					done({ action: "clear" });
					return;
				}

				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	return result ?? { action: "unsupported" };
}

interface ManageDraftsOptions {
	onUnsupported: "list" | "restore-latest";
}

async function manageDrafts(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	drafts: readonly string[],
	options: ManageDraftsOptions = { onUnsupported: "list" },
): Promise<string[]> {
	if (!ensureEditor(ctx, "Listing stashes")) return [...drafts];
	if (drafts.length === 0) {
		ctx.ui.notify("No stashed drafts", "info");
		return [...drafts];
	}

	let nextDrafts = [...drafts];
	let selectedIndex = 0;

	while (nextDrafts.length > 0) {
		const result = await showDraftPicker(ctx, nextDrafts, selectedIndex);

		if (result.action === "unsupported") {
			if (options.onUnsupported === "restore-latest") {
				ctx.ui.notify("Stash picker unavailable in this client; using the latest stash for restore.", "info");
				return await restoreDraftAt(pi, ctx, nextDrafts, 0);
			}

			ctx.ui.notify(`Stashed drafts (latest first):\n${summarizeDrafts(nextDrafts)}`, "info");
			return nextDrafts;
		}

		if (result.action === "cancel") {
			return nextDrafts;
		}

		if (result.action === "restore") {
			return await restoreDraftAt(pi, ctx, nextDrafts, result.index);
		}

		if (result.action === "clear") {
			const confirmed = await ctx.ui.confirm("Clear all stashes?", "Delete all stashed drafts?");
			if (confirmed) return clearDrafts(pi, ctx);
			continue;
		}

		const removed = removeDraftAt(nextDrafts, result.index);
		if (!removed.draft) {
			ctx.ui.notify("No stashed draft at that position", "warning");
			selectedIndex = 0;
			continue;
		}

		nextDrafts = removed.remaining;
		persistState(pi, nextDrafts);
		updateStatus(ctx, nextDrafts);
		ctx.ui.notify(`Deleted stashed draft: ${previewDraft(removed.draft)}`, "info");
		selectedIndex = removed.nextIndex;
	}

	return nextDrafts;
}

async function restoreLatestOrPick(pi: ExtensionAPI, ctx: ExtensionContext, drafts: readonly string[]): Promise<string[]> {
	if (drafts.length === 0) {
		ctx.ui.notify("No stashed drafts", "warning");
		return [...drafts];
	}

	if (drafts.length === 1) {
		return await restoreDraftAt(pi, ctx, drafts, 0);
	}

	return manageDrafts(pi, ctx, drafts, { onUnsupported: "restore-latest" });
}

export default function piStash(pi: ExtensionAPI): void {
	let drafts: string[] = [];

	const syncDraftsFromBranch = (ctx: ExtensionContext) => {
		drafts = hydrateState(ctx.sessionManager.getBranch()).drafts;
		updateStatus(ctx, drafts);
	};

	pi.on("session_start", async (_event, ctx) => {
		syncDraftsFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncDraftsFromBranch(ctx);
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Stash the current draft and clear the editor",
		handler: async (ctx) => {
			drafts = stashEditor(pi, ctx, drafts);
		},
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Restore the latest stashed draft, or pick from multiple drafts",
		handler: async (ctx) => {
			drafts = await restoreLatestOrPick(pi, ctx, drafts);
		},
	});

	pi.registerCommand("stash", {
		description: "Stash the current editor draft, or stash the provided text",
		handler: async (args, ctx) => {
			if (args.length > 0) {
				if (isBlankDraft(args)) {
					ctx.ui.notify("Nothing to stash", "warning");
					return;
				}
				drafts = stashDraft(pi, ctx, drafts, args);
				return;
			}

			drafts = stashEditor(pi, ctx, drafts);
		},
	});

	pi.registerCommand("stash-list", {
		description: "Browse stashed drafts, restore one, delete one, or clear all",
		handler: async (_args, ctx) => {
			drafts = await manageDrafts(pi, ctx, drafts);
		},
	});
}
