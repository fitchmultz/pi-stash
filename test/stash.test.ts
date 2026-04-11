/**
 * Purpose: Verify branch-aware and RPC-safe behavior for the pi-stash extension entrypoint.
 * Responsibilities: Cover branch rehydration, explicit `/stash` argument preservation, and RPC fallbacks when custom UI is unavailable.
 * Scope: Integration-style tests around `extensions/stash.ts` with mocked pi extension APIs.
 * Usage: Run with `npm test` or `npm run test:node20`; both commands transpile the test bundle into `.tmp/test-dist/` first.
 * Invariants/Assumptions: Mocked contexts emulate the extension API surface closely enough to catch stash-state regressions without spinning up a full pi runtime.
 */

import assert from "node:assert/strict";
import test from "node:test";

import piStash from "../extensions/stash.ts";
import { STASH_ENTRY_TYPE, type PersistedEntry } from "../extensions/state.ts";

interface AppendedEntry {
	type: string;
	data: { drafts: string[] };
}

interface Notification {
	message: string;
	type: string;
}

interface StatusUpdate {
	key: string;
	text: string | undefined;
}

interface TestTheme {
	fg?(name: string, value: string): string;
	bold?(value: string): string;
}

interface TestUI {
	theme?: TestTheme;
	notify(message: string, type: string): void;
	setStatus(key: string, text: string | undefined): void;
	getEditorText(): string;
	setEditorText(text: string): void;
	pasteToEditor(text: string): void;
	confirm(title: string, message?: string): Promise<boolean>;
	custom<T>(
		renderer: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown,
	): Promise<T | undefined>;
}

interface TestContext {
	hasUI: boolean;
	ui: TestUI;
	sessionManager: {
		getBranch(): PersistedEntry[];
		getEntries(): PersistedEntry[];
	};
}

interface RegisteredCommand {
	description: string;
	handler(args: string, ctx: TestContext): Promise<void>;
}

interface RegisteredShortcut {
	description: string;
	handler(ctx: TestContext): Promise<void>;
}

interface RegisteredEvent {
	(event: unknown, ctx: TestContext): Promise<void>;
}

function createHarness() {
	const commands = new Map<string, RegisteredCommand>();
	const shortcuts = new Map<string, RegisteredShortcut>();
	const events = new Map<string, RegisteredEvent>();
	const appended: AppendedEntry[] = [];

	piStash({
		on(eventName: string, handler: RegisteredEvent) {
			events.set(eventName, handler);
		},
		registerCommand(name: string, options: RegisteredCommand) {
			commands.set(name, options);
		},
		registerShortcut(name: string, options: RegisteredShortcut) {
			shortcuts.set(name, options);
		},
		appendEntry(type: string, data: AppendedEntry["data"]) {
			appended.push({ type, data });
		},
	} as never);

	return { commands, shortcuts, events, appended };
}

function createContext(options: {
	branchEntries?: PersistedEntry[];
	allEntries?: PersistedEntry[];
	editorText?: string;
	theme?: TestTheme;
	customResult?: unknown;
	confirmResult?: boolean;
	hasUI?: boolean;
}) {
	const notifications: Notification[] = [];
	const statuses: StatusUpdate[] = [];
	let editorText = options.editorText ?? "";
	let branchEntries = options.branchEntries ?? [];
	let allEntries = options.allEntries ?? branchEntries;
	const customResult = options.customResult;
	const confirmResult = options.confirmResult ?? true;

	const ctx: TestContext = {
		hasUI: options.hasUI ?? true,
		ui: {
			theme: options.theme,
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus(key, text) {
				statuses.push({ key, text });
			},
			getEditorText() {
				return editorText;
			},
			setEditorText(text) {
				editorText = text;
			},
			pasteToEditor(text) {
				editorText += text;
			},
			async confirm() {
				return confirmResult;
			},
			async custom<T>() {
				return customResult as T | undefined;
			},
		},
		sessionManager: {
			getBranch() {
				return branchEntries;
			},
			getEntries() {
				return allEntries;
			},
		},
	};

	return {
		ctx,
		notifications,
		statuses,
		get editorText() {
			return editorText;
		},
		setBranchEntries(next: PersistedEntry[]) {
			branchEntries = next;
		},
		setAllEntries(next: PersistedEntry[]) {
			allEntries = next;
		},
	};
}

function stashSnapshot(...drafts: string[]): PersistedEntry {
	return {
		type: "custom",
		customType: STASH_ENTRY_TYPE,
		data: { drafts },
	};
}

test("/stash preserves explicit whitespace exactly and falls back to plain status text when theme styling is unavailable", async () => {
	const harness = createHarness();
	const context = createContext({
		branchEntries: [],
		allEntries: [stashSnapshot("ignored global draft")],
		theme: undefined,
	});

	await harness.events.get("session_start")?.({}, context.ctx);
	await harness.commands.get("stash")?.handler("  keep surrounding spaces  ", context.ctx);

	assert.deepEqual(harness.appended.at(-1), {
		type: STASH_ENTRY_TYPE,
		data: { drafts: ["  keep surrounding spaces  "] },
	});
	assert.deepEqual(context.statuses.at(-1), { key: "pi-stash", text: "📦 1 draft" });
});

test("stash state rehydrates from the current branch on session start and tree navigation", async () => {
	const harness = createHarness();
	const context = createContext({
		branchEntries: [stashSnapshot("branch draft")],
		allEntries: [stashSnapshot("branch draft"), stashSnapshot("other-branch newest")],
		theme: { fg: (_name, value) => value },
	});

	await harness.events.get("session_start")?.({}, context.ctx);
	await harness.commands.get("stash")?.handler("fresh", context.ctx);

	assert.deepEqual(harness.appended.at(-1), {
		type: STASH_ENTRY_TYPE,
		data: { drafts: ["fresh", "branch draft"] },
	});

	context.setBranchEntries([stashSnapshot("tree branch draft")]);
	await harness.events.get("session_tree")?.({}, context.ctx);
	await harness.commands.get("stash")?.handler("after tree", context.ctx);

	assert.deepEqual(harness.appended.at(-1), {
		type: STASH_ENTRY_TYPE,
		data: { drafts: ["after tree", "tree branch draft"] },
	});
});

test("RPC-like restore falls back to the latest draft when the custom picker is unavailable", async () => {
	const harness = createHarness();
	const context = createContext({
		branchEntries: [],
		allEntries: [],
		theme: undefined,
		customResult: undefined,
		editorText: "",
	});

	await harness.commands.get("stash")?.handler("older", context.ctx);
	await harness.commands.get("stash")?.handler("latest", context.ctx);
	await harness.shortcuts.get("ctrl+shift+r")?.handler(context.ctx);

	assert.equal(context.editorText, "latest");
	assert.deepEqual(harness.appended.at(-1), {
		type: STASH_ENTRY_TYPE,
		data: { drafts: ["older"] },
	});
	assert.equal(
		context.notifications.some((entry) => entry.message.includes("using the latest stash for restore")),
		true,
	);
});

test("RPC-like restore does not replace editor text when the destructive confirmation is declined", async () => {
	const harness = createHarness();
	const context = createContext({
		branchEntries: [],
		allEntries: [],
		theme: undefined,
		customResult: undefined,
		confirmResult: false,
		editorText: "host draft",
	});

	await harness.commands.get("stash")?.handler("older", context.ctx);
	await harness.commands.get("stash")?.handler("latest", context.ctx);
	await harness.shortcuts.get("ctrl+shift+r")?.handler(context.ctx);

	assert.equal(context.editorText, "host draft");
	assert.deepEqual(harness.appended.at(-1), {
		type: STASH_ENTRY_TYPE,
		data: { drafts: ["latest", "older"] },
	});
	assert.equal(context.notifications.some((entry) => entry.message === "Restore cancelled"), true);
});

test("RPC-like stash-list falls back to a textual summary when the custom picker is unavailable", async () => {
	const harness = createHarness();
	const context = createContext({
		branchEntries: [],
		allEntries: [],
		theme: undefined,
		customResult: undefined,
	});

	await harness.commands.get("stash")?.handler("older", context.ctx);
	await harness.commands.get("stash")?.handler("latest", context.ctx);
	const lastPersisted = harness.appended.at(-1);

	await harness.commands.get("stash-list")?.handler("", context.ctx);

	assert.deepEqual(harness.appended.at(-1), lastPersisted);
	assert.equal(
		context.notifications.some(
			(entry) => entry.message.includes("Stashed drafts (latest first):") && entry.message.includes("1. latest"),
		),
		true,
	);
});

test("/stash ignores whitespace-only explicit text", async () => {
	const harness = createHarness();
	const context = createContext({ branchEntries: [], allEntries: [] });

	await harness.commands.get("stash")?.handler("   ", context.ctx);

	assert.equal(harness.appended.length, 0);
	assert.equal(context.notifications.some((entry) => entry.message === "Nothing to stash"), true);
});
