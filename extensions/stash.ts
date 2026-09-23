/**
 * Purpose: Add fast stash-and-restore draft workflow to the pi editor.
 * Responsibilities: Capture editor drafts, restore them later, persist stash state, and expose shortcuts and picker-based stash management.
 * Scope: Interactive editor draft management for a single pi session.
 * Usage: Install as a pi package, then use Ctrl+Shift+S to stash and Ctrl+Shift+R to restore or pick from multiple drafts.
 * Invariants/Assumptions: Drafts are restored newest-first by default, blank drafts are never stashed, and non-TUI clients use confirmation or summary flows.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyHint, rawKeyHint, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
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

const INTERACTION_CANCELLED = Symbol("interaction-cancelled");
const RECOVERY_SUFFIX = "-pi-stash-recovery.jsonl";
const RECOVERY_OPENED_TYPE = "pi-stash-recovery-opened";

interface Interaction {
	readonly cancelled: boolean;
	readonly signal: AbortSignal;
	cancel(): void;
	onCancel(callback: () => void): void;
	wait<T>(promise: Promise<T>): Promise<T | typeof INTERACTION_CANCELLED>;
}

function createInteraction(): Interaction {
	let cancelled = false;
	const controller = new AbortController();
	let resolveCancellation: () => void;
	const cancellation = new Promise<void>((resolve) => {
		resolveCancellation = resolve;
	});
	const callbacks = new Set<() => void>();

	return {
		get cancelled() {
			return cancelled;
		},
		signal: controller.signal,
		cancel() {
			if (cancelled) return;
			cancelled = true;
			controller.abort();
			for (const callback of callbacks) callback();
			resolveCancellation();
		},
		onCancel(callback) {
			if (cancelled) callback();
			else callbacks.add(callback);
		},
		async wait<T>(promise: Promise<T>) {
			return (await Promise.race([promise, cancellation.then(() => INTERACTION_CANCELLED)])) as
				| T
				| typeof INTERACTION_CANCELLED;
		},
	};
}

function supportsCustomPicker(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

function requiresReplaceConfirmation(ctx: ExtensionContext): boolean {
	return ctx.mode === "rpc";
}

function updateStatus(ctx: ExtensionContext, drafts: readonly string[]): void {
	if (drafts.length === 0) {
		ctx.ui.setStatus("pi-stash", undefined);
		return;
	}

	ctx.ui.setStatus("pi-stash", ctx.ui.theme.fg("accent", `📦 ${countLabel(drafts.length)}`));
}

function makeMostRecent(ctx: ExtensionContext, sessionFile: string): void {
	const dir = ctx.sessionManager.getSessionDir();
	const newest = readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.reduce((mtime, name) => Math.max(mtime, statSync(join(dir, name)).mtimeMs), Date.now());
	utimesSync(sessionFile, new Date(), new Date(Math.ceil(newest) + 1));
}

function removeUnusedRecoveries(ctx: ExtensionContext, drafts: readonly string[]): void {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) return;

	try {
		const dir = ctx.sessionManager.getSessionDir();
		const prefix = `${parse(sessionFile).name}-`;
		const recoveries = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(RECOVERY_SUFFIX));
		if (recoveries.length === 0) return;

		const saved = hydrateState(SessionManager.open(sessionFile).getBranch()).drafts;
		if (saved.length !== drafts.length || saved.some((draft, index) => draft !== drafts[index])) return;
		for (const name of recoveries) {
			const recovery = join(dir, name);
			const entries = SessionManager.open(recovery).getEntries();
			if (entries.length !== 2) continue;
			const snapshot = entries[1];
			const owner = snapshot.type === "custom" && snapshot.customType === STASH_ENTRY_TYPE
				? (snapshot.data as { originSessionFile?: string } | undefined)?.originSessionFile
				: undefined;
			if (owner === sessionFile || (owner === undefined && name === `${parse(sessionFile).name}${RECOVERY_SUFFIX}`)) {
				rmSync(recovery);
			}
		}
	} catch {
		// Keep recovery sessions if the original cannot be verified or cleaned up.
	}
}

function persistState(pi: ExtensionAPI, ctx: ExtensionContext, drafts: readonly string[]): void {
	pi.appendEntry(STASH_ENTRY_TYPE, { drafts: [...drafts] });
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return;
	if (existsSync(sessionFile)) {
		removeUnusedRecoveries(ctx, drafts);
		if (sessionFile.endsWith(RECOVERY_SUFFIX)) makeMostRecent(ctx, sessionFile);
		return;
	}

	const dir = ctx.sessionManager.getSessionDir();
	const recovery = join(dir, `${parse(sessionFile).name}-${randomUUID()}${RECOVERY_SUFFIX}`);
	const temporary = `${recovery}.tmp`;
	try {
		writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
		const saved = SessionManager.open(temporary, dir, ctx.cwd);
		saved.appendSessionInfo("Stashed drafts");
		saved.appendCustomEntry(STASH_ENTRY_TYPE, { drafts: [...drafts], originSessionFile: sessionFile });
		renameSync(temporary, recovery);
		// ponytail: Official Pi cannot claim a recovery before session_start. Keep older copies until its original session saves; retire this fallback when official Pi saves custom entries eagerly.
		makeMostRecent(ctx, recovery);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function ensureEditor(ctx: ExtensionContext, action: string): boolean {
	if (ctx.hasUI) return true;
	ctx.ui.notify(`${action} requires the interactive editor`, "warning");
	return false;
}

function stashDraft(pi: ExtensionAPI, ctx: ExtensionContext, drafts: readonly string[], draft: string): string[] {
	const nextDrafts = pushDraft(drafts, draft, MAX_STASHED_DRAFTS);
	persistState(pi, ctx, nextDrafts);
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

	const nextDrafts = stashDraft(pi, ctx, drafts, draft);
	ctx.ui.setEditorText("");
	return nextDrafts;
}

function insertDraftIntoEditor(ctx: ExtensionContext, draft: string): void {
	if (isBlankDraft(ctx.ui.getEditorText())) {
		ctx.ui.setEditorText(draft);
		return;
	}

	ctx.ui.pasteToEditor(draft);
}

async function restoreDraftAt(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	drafts: readonly string[],
	index: number,
	interaction: Interaction,
): Promise<string[]> {
	if (!ensureEditor(ctx, "Restoring")) return [...drafts];

	const { draft, remaining } = removeDraftAt(drafts, index);
	if (!draft) {
		ctx.ui.notify("No stashed draft at that position", "warning");
		return [...drafts];
	}

	if (requiresReplaceConfirmation(ctx)) {
		const confirmation = ctx.ui.confirm(
			"Replace editor with stashed draft?",
			"This non-TUI client cannot safely merge stashed drafts with existing editor text. Restoring will replace the current editor contents.",
			{ signal: interaction.signal },
		);
		const confirmed = await interaction.wait(confirmation);
		if (interaction.cancelled || confirmed === INTERACTION_CANCELLED) return [...drafts];
		if (!confirmed) {
			ctx.ui.notify("Restore cancelled", "info");
			return [...drafts];
		}

		ctx.ui.setEditorText(draft);
	} else {
		insertDraftIntoEditor(ctx, draft);
	}
	persistState(pi, ctx, remaining);
	updateStatus(ctx, remaining);
	ctx.ui.notify(`Restored draft: ${previewDraft(draft)}`, "info");
	return remaining;
}

function clearDrafts(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
	persistState(pi, ctx, []);
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
	interaction: Interaction,
): Promise<DraftPickerResult> {
	if (!supportsCustomPicker(ctx)) return { action: "unsupported" };

	const items = buildDraftItems(drafts);

	const picker = ctx.ui.custom<DraftPickerResult>((tui, theme, _keybindings, done) => {
		interaction.onCancel(() => done({ action: "cancel" }));
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
						keyHint("tui.select.confirm", "restore"),
						rawKeyHint("ctrl+d", "delete"),
						rawKeyHint("ctrl+x", "clear all"),
						keyHint("tui.select.cancel", "cancel"),
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
	const result = await interaction.wait(picker);

	return result === INTERACTION_CANCELLED ? { action: "cancel" } : (result ?? { action: "unsupported" });
}

interface ManageDraftsOptions {
	onUnsupported: "list" | "restore-latest";
}

async function manageDrafts(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	drafts: readonly string[],
	interaction: Interaction,
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
		const result = await showDraftPicker(ctx, nextDrafts, selectedIndex, interaction);

		if (result.action === "unsupported") {
			if (options.onUnsupported === "restore-latest") {
				ctx.ui.notify("Stash picker unavailable in this client; using the latest stash for restore.", "info");
				return await restoreDraftAt(pi, ctx, nextDrafts, 0, interaction);
			}

			ctx.ui.notify(`Stashed drafts (latest first):\n${summarizeDrafts(nextDrafts)}`, "info");
			return nextDrafts;
		}

		if (result.action === "cancel") {
			return nextDrafts;
		}

		if (result.action === "restore") {
			return await restoreDraftAt(pi, ctx, nextDrafts, result.index, interaction);
		}

		if (result.action === "clear") {
			const confirmed = await interaction.wait(
				ctx.ui.confirm("Clear all stashes?", "Delete all stashed drafts?", { signal: interaction.signal }),
			);
			if (interaction.cancelled || confirmed === INTERACTION_CANCELLED) return nextDrafts;
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
		persistState(pi, ctx, nextDrafts);
		updateStatus(ctx, nextDrafts);
		ctx.ui.notify(`Deleted stashed draft: ${previewDraft(removed.draft)}`, "info");
		selectedIndex = removed.nextIndex;
	}

	return nextDrafts;
}

async function restoreLatestOrPick(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	drafts: readonly string[],
	interaction: Interaction,
): Promise<string[]> {
	if (drafts.length === 0) {
		ctx.ui.notify("No stashed drafts", "warning");
		return [...drafts];
	}

	if (drafts.length === 1) {
		return await restoreDraftAt(pi, ctx, drafts, 0, interaction);
	}

	return manageDrafts(pi, ctx, drafts, interaction, { onUnsupported: "restore-latest" });
}

export default function piStash(pi: ExtensionAPI): void {
	let drafts: string[] = [];
	let generation = 0;
	let pendingInteraction: Interaction | undefined;
	let pendingOperation: Promise<void> = Promise.resolve();

	const enqueue = (operation: () => void | Promise<void>): Promise<void> => {
		const requestedGeneration = generation;
		const result = pendingOperation.then(
			() => requestedGeneration === generation && operation(),
			() => requestedGeneration === generation && operation(),
		);
		pendingOperation = result.then(() => {}, () => {});
		return result.then(() => {});
	};

	const enqueueInteraction = (operation: (interaction: Interaction) => Promise<void>): Promise<void> =>
		enqueue(async () => {
			const interaction = createInteraction();
			pendingInteraction = interaction;
			try {
				await operation(interaction);
			} finally {
				if (pendingInteraction === interaction) pendingInteraction = undefined;
			}
		});

	const reset = (ctx: ExtensionContext, nextDrafts: string[]) => {
		generation++;
		pendingInteraction?.cancel();
		pendingInteraction = undefined;
		drafts = nextDrafts;
		updateStatus(ctx, drafts);
	};

	pi.on("session_start", async (_event, ctx) => {
		reset(ctx, hydrateState(ctx.sessionManager.getBranch()).drafts);
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile?.endsWith(RECOVERY_SUFFIX)) {
			if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === RECOVERY_OPENED_TYPE)) {
				pi.appendEntry(RECOVERY_OPENED_TYPE);
			}
			makeMostRecent(ctx, sessionFile);
		} else {
			removeUnusedRecoveries(ctx, drafts);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		reset(ctx, hydrateState(ctx.sessionManager.getBranch()).drafts);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		removeUnusedRecoveries(ctx, drafts);
		reset(ctx, []);
	});

	pi.on("agent_end", async (_event, ctx) => {
		removeUnusedRecoveries(ctx, drafts);
	});

	// Additive fork event; older Pi hosts simply never dispatch it. Keep stock API typing elsewhere.
	(pi.on as unknown as (event: "session_checkpoint", handler: (
		event: unknown, ctx: ExtensionContext,
	) => { sleepReady: boolean; reason?: string }) => void)("session_checkpoint", (_event, ctx) => {
		// Commands/shortcuts return pendingOperation to Pi: native ingress owns and joins that chain.
		// Never cancel a picker, stash editor text, or run shutdown just to make a checkpoint pass.
		if (pendingInteraction) return { sleepReady: false, reason: "Stash interaction is still live" };
		const saved = hydrateState(ctx.sessionManager.getBranch()).drafts;
		if (saved.length !== drafts.length || saved.some((draft, index) => draft !== drafts[index])) {
			return { sleepReady: false, reason: "Stash state differs from the selected branch" };
		}
		return { sleepReady: true };
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Stash the current draft and clear the editor",
		handler: (ctx) =>
			enqueue(() => {
				drafts = stashEditor(pi, ctx, drafts);
			}),
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Restore the latest stashed draft, or pick from multiple drafts",
		handler: (ctx) =>
			enqueueInteraction(async (interaction) => {
				const nextDrafts = await restoreLatestOrPick(pi, ctx, drafts, interaction);
				if (!interaction.cancelled) drafts = nextDrafts;
			}),
	});

	pi.registerCommand("stash", {
		description: "Stash the current editor draft, or stash the provided text",
		handler: (args, ctx) =>
			enqueue(() => {
				if (args.length > 0) {
					if (isBlankDraft(args)) {
						ctx.ui.notify("Nothing to stash", "warning");
						return;
					}
					try {
						drafts = stashDraft(pi, ctx, drafts, args);
					} catch (error) {
						if (ctx.hasUI && isBlankDraft(ctx.ui.getEditorText())) ctx.ui.setEditorText(args);
						throw error;
					}
					return;
				}

				drafts = stashEditor(pi, ctx, drafts);
			}),
	});

	pi.registerCommand("stash-list", {
		description: "Browse stashed drafts, restore one, delete one, or clear all",
		handler: (_args, ctx) =>
			enqueueInteraction(async (interaction) => {
				const nextDrafts = await manageDrafts(pi, ctx, drafts, interaction);
				if (!interaction.cancelled) drafts = nextDrafts;
			}),
	});
}
