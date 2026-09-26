/**
 * Purpose: Add fast stash-and-restore draft workflow to the pi editor.
 * Responsibilities: Capture editor drafts, restore them later, persist the stash per project directory, and expose shortcuts and picker-based stash management.
 * Scope: Interactive editor draft management shared by every pi session in one working directory.
 * Usage: Install as a pi package, then use Ctrl+Shift+S to stash and Ctrl+Shift+R to restore or pick from multiple drafts.
 * Invariants/Assumptions: Drafts are restored newest-first by default, blank drafts are never stashed, the project file is re-read before every mutation, and non-TUI clients use confirmation or summary flows.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, keyHint, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
	clampSelectedIndex,
	countLabel,
	hydrateState,
	isBlankDraft,
	MAX_STASHED_DRAFTS,
	previewDraft,
	pushDraft,
	readDrafts,
	STASH_ENTRY_TYPE,
	withoutDraft,
} from "./state.ts";

type DraftPickerResult =
	| { action: "restore"; index: number }
	| { action: "delete"; index: number }
	| { action: "clear" }
	| { action: "cancel" }
	| { action: "unsupported" };

const INTERACTION_CANCELLED = Symbol("interaction-cancelled");

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
	const cancellation = Promise.withResolvers<void>();
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
			cancellation.resolve();
		},
		onCancel(callback) {
			if (cancelled) callback();
			else callbacks.add(callback);
		},
		async wait<T>(promise: Promise<T>) {
			return await Promise.race([promise, cancellation.promise.then((): typeof INTERACTION_CANCELLED => INTERACTION_CANCELLED)]);
		},
	};
}

function stashFile(cwd: string): string {
	const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(getAgentDir(), "pi-stash", `${key}.json`);
}

function loadDrafts(cwd: string): string[] {
	const file = stashFile(cwd);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	// Refuse to overwrite a file we cannot read back; it may hold the user's only copy of a draft.
	const drafts = readDrafts(JSON.parse(text));
	if (!drafts) throw new Error(`Invalid stash file: ${file}`);
	return drafts;
}

function saveDrafts(cwd: string, drafts: readonly string[]): void {
	const file = stashFile(cwd);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ cwd, drafts })}\n`, { mode: 0o600 });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function updateStatus(ctx: ExtensionContext, drafts: readonly string[]): void {
	ctx.ui.setStatus("pi-stash", drafts.length === 0 ? undefined : ctx.ui.theme.fg("accent", `📦 ${countLabel(drafts.length)}`));
}

// ponytail: unlocked read-modify-write; two windows mutating in the same instant resolve last-writer-wins. Add a lockfile if that ever loses a draft.
function updateDrafts(ctx: ExtensionContext, update: (drafts: string[]) => string[]): string[] {
	const drafts = update(loadDrafts(ctx.cwd));
	saveDrafts(ctx.cwd, drafts);
	updateStatus(ctx, drafts);
	return drafts;
}

function ensureEditor(ctx: ExtensionContext, action: string): boolean {
	if (ctx.hasUI) return true;
	ctx.ui.notify(`${action} requires the interactive editor`, "warning");
	return false;
}

function stashDraft(ctx: ExtensionContext, draft: string): void {
	let dropped = false;
	const drafts = updateDrafts(ctx, (current) => {
		dropped = current.length >= MAX_STASHED_DRAFTS;
		return pushDraft(current, draft);
	});
	ctx.ui.notify(`Stashed ${countLabel(drafts.length)}: ${previewDraft(draft)}${dropped ? " Oldest draft dropped." : ""}`, "info");
}

function stashEditor(ctx: ExtensionContext): void {
	if (!ensureEditor(ctx, "Stashing")) return;

	const draft = ctx.ui.getEditorText();
	if (isBlankDraft(draft)) {
		ctx.ui.notify("Nothing to stash", "warning");
		return;
	}

	stashDraft(ctx, draft);
	ctx.ui.setEditorText("");
}

async function restoreDraft(ctx: ExtensionContext, draft: string, interaction: Interaction): Promise<void> {
	if (!ensureEditor(ctx, "Restoring")) return;

	if (ctx.mode === "rpc") {
		const confirmed = await interaction.wait(ctx.ui.confirm(
			"Replace editor with stashed draft?",
			"This non-TUI client cannot safely merge stashed drafts with existing editor text. Restoring will replace the current editor contents.",
			{ signal: interaction.signal },
		));
		if (interaction.cancelled || confirmed === INTERACTION_CANCELLED) return;
		if (!confirmed) {
			ctx.ui.notify("Restore cancelled", "info");
			return;
		}
		ctx.ui.setEditorText(draft);
	} else if (isBlankDraft(ctx.ui.getEditorText())) {
		ctx.ui.setEditorText(draft);
	} else {
		ctx.ui.pasteToEditor(draft);
	}
	updateDrafts(ctx, (current) => withoutDraft(current, draft));
	ctx.ui.notify(`Restored draft: ${previewDraft(draft)}`, "info");
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
	if (ctx.mode !== "tui") return { action: "unsupported" };

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

async function manageDrafts(
	ctx: ExtensionContext,
	interaction: Interaction,
	onUnsupported: "list" | "restore-latest" = "list",
): Promise<void> {
	if (!ensureEditor(ctx, "Listing stashes")) return;
	let drafts = loadDrafts(ctx.cwd);
	if (drafts.length === 0) {
		ctx.ui.notify("No stashed drafts", "info");
		return;
	}

	let selectedIndex = 0;
	while (drafts.length > 0) {
		const result = await showDraftPicker(ctx, drafts, selectedIndex, interaction);

		if (result.action === "unsupported") {
			if (onUnsupported === "restore-latest") {
				ctx.ui.notify("Stash picker unavailable in this client; using the latest stash for restore.", "info");
				return restoreDraft(ctx, drafts[0], interaction);
			}
			const summary = drafts.map((draft, index) => `${index + 1}. ${previewDraft(draft, 64)}`).join("\n");
			ctx.ui.notify(`Stashed drafts (latest first):\n${summary}`, "info");
			return;
		}

		if (result.action === "cancel") return;

		if (result.action === "clear") {
			const confirmed = await interaction.wait(
				ctx.ui.confirm("Clear all stashes?", "Delete all stashed drafts?", { signal: interaction.signal }),
			);
			if (interaction.cancelled || confirmed === INTERACTION_CANCELLED) return;
			if (!confirmed) continue;
			updateDrafts(ctx, () => []);
			ctx.ui.notify("Cleared stashed drafts", "info");
			return;
		}

		const draft = drafts[result.index];
		if (draft === undefined) {
			ctx.ui.notify("No stashed draft at that position", "warning");
			selectedIndex = 0;
			continue;
		}
		if (result.action === "restore") return restoreDraft(ctx, draft, interaction);

		drafts = updateDrafts(ctx, (current) => withoutDraft(current, draft));
		ctx.ui.notify(`Deleted stashed draft: ${previewDraft(draft)}`, "info");
		selectedIndex = result.index;
	}
}

async function restoreLatestOrPick(ctx: ExtensionContext, interaction: Interaction): Promise<void> {
	const drafts = loadDrafts(ctx.cwd);
	if (drafts.length === 0) {
		ctx.ui.notify("No stashed drafts", "warning");
		return;
	}
	if (drafts.length === 1) return restoreDraft(ctx, drafts[0], interaction);
	return manageDrafts(ctx, interaction, "restore-latest");
}

function importSessionDrafts(pi: ExtensionAPI, ctx: ExtensionContext): void {
	// Releases before 0.3.0 kept the stash in session entries.
	const legacy = hydrateState(ctx.sessionManager.getBranch());
	if (legacy.length === 0) {
		updateStatus(ctx, loadDrafts(ctx.cwd));
		return;
	}

	let imported = 0;
	let dropped = 0;
	updateDrafts(ctx, (current) => {
		const added = legacy.filter((draft) => !current.includes(draft));
		imported = added.length;
		dropped = Math.max(0, current.length + added.length - MAX_STASHED_DRAFTS);
		return [...current, ...added].slice(0, MAX_STASHED_DRAFTS);
	});
	pi.appendEntry(STASH_ENTRY_TYPE, { drafts: [] });
	if (imported === 0) return;
	const suffix = dropped > 0 ? ` ${countLabel(dropped)} over the limit stayed in the session history.` : "";
	ctx.ui.notify(`Imported ${countLabel(imported)} from this session into the project stash.${suffix}`, "info");
}

export default function piStash(pi: ExtensionAPI): void {
	let generation = 0;
	let pendingInteraction: Interaction | undefined;
	let pendingOperation: Promise<void> = Promise.resolve();

	const enqueue = (operation: () => void | Promise<void>): Promise<void> => {
		const requestedGeneration = generation;
		const run = () => requestedGeneration === generation && operation();
		const result = pendingOperation.then(run, run);
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

	const reset = () => {
		generation++;
		pendingInteraction?.cancel();
		pendingInteraction = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		reset();
		importSessionDrafts(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		reset();
		ctx.ui.setStatus("pi-stash", undefined);
	});

	// Additive fork event; official Pi never dispatches it. Keep stock API typing elsewhere.
	(pi.on as unknown as (event: "session_checkpoint", handler: () => { sleepReady: boolean; reason?: string }) => void)(
		"session_checkpoint",
		// Every mutation is already on disk; only a live picker or confirmation holds unsaved intent.
		() => (pendingInteraction ? { sleepReady: false, reason: "Stash interaction is still live" } : { sleepReady: true }),
	);

	pi.registerShortcut("ctrl+shift+s", {
		description: "Stash the current draft and clear the editor",
		handler: (ctx) => enqueue(() => stashEditor(ctx)),
	});

	pi.registerShortcut("ctrl+shift+r", {
		description: "Restore the latest stashed draft, or pick from multiple drafts",
		handler: (ctx) => enqueueInteraction((interaction) => restoreLatestOrPick(ctx, interaction)),
	});

	pi.registerCommand("stash", {
		description: "Stash the current editor draft, or stash the provided text",
		handler: (args, ctx) =>
			enqueue(() => {
				if (args.length === 0) return stashEditor(ctx);
				if (isBlankDraft(args)) {
					ctx.ui.notify("Nothing to stash", "warning");
					return;
				}
				try {
					stashDraft(ctx, args);
				} catch (error) {
					if (ctx.hasUI && isBlankDraft(ctx.ui.getEditorText())) ctx.ui.setEditorText(args);
					throw error;
				}
			}),
	});

	pi.registerCommand("stash-list", {
		description: "Browse stashed drafts, restore one, delete one, or clear all",
		handler: (_args, ctx) => enqueueInteraction((interaction) => manageDrafts(ctx, interaction)),
	});
}
