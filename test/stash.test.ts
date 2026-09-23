/**
 * Purpose: Verify branch-aware and RPC-safe behavior for the pi-stash extension entrypoint.
 * Responsibilities: Cover branch rehydration, explicit `/stash` argument preservation, and RPC fallbacks when custom UI is unavailable.
 * Scope: Integration-style tests around `extensions/stash.ts` with mocked pi extension APIs.
 * Usage: Run with `npm test` or `npm run test:node22`; both commands transpile the test bundle into `.tmp/test-dist/` first.
 * Invariants/Assumptions: Mocked contexts emulate the extension API surface closely enough to catch stash-state regressions without spinning up a full pi runtime.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import piStash from "../extensions/stash.ts";
import { hydrateState, STASH_ENTRY_TYPE, type PersistedEntry } from "../extensions/state.ts";

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
	fg(name: string, value: string): string;
	bold(value: string): string;
}

interface TestDialogOptions {
	signal?: AbortSignal;
}

interface TestUI {
	theme: TestTheme;
	notify(message: string, type: string): void;
	setStatus(key: string, text: string | undefined): void;
	getEditorText(): string;
	setEditorText(text: string): void;
	pasteToEditor(text: string): void;
	confirm(title: string, message: string, options?: TestDialogOptions): Promise<boolean>;
	custom<T>(
		renderer: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown,
	): Promise<T | undefined>;
}

interface TestContext {
	mode: "tui" | "rpc" | "json" | "print";
	hasUI: boolean;
	cwd: string;
	ui: TestUI;
	sessionManager: {
		getBranch(): PersistedEntry[];
		getEntries(): PersistedEntry[];
		getSessionDir(): string;
		getSessionFile(): string | undefined;
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
	(event: unknown, ctx: TestContext): unknown;
}

function createHarness(appendEntry?: (type: string, data: AppendedEntry["data"]) => void) {
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
			appendEntry?.(type, data);
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
	custom?: TestUI["custom"];
	confirmResult?: boolean;
	confirm?: (title: string, message: string, options?: TestDialogOptions) => Promise<boolean>;
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	cwd?: string;
	sessionManager?: TestContext["sessionManager"];
}) {
	const notifications: Notification[] = [];
	const statuses: StatusUpdate[] = [];
	let editorText = options.editorText ?? "";
	let branchEntries = options.branchEntries ?? [];
	let allEntries = options.allEntries ?? branchEntries;
	const customResult = options.customResult;
	const confirmResult = options.confirmResult ?? true;

	const ctx: TestContext = {
		mode: options.mode ?? (options.hasUI === false ? "print" : options.theme ? "tui" : "rpc"),
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? process.cwd(),
		ui: {
			theme: options.theme ?? { fg: (_name, value) => value, bold: (value) => value },
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
			async confirm(title, message, dialogOptions) {
				return options.confirm?.(title, message, dialogOptions) ?? confirmResult;
			},
			async custom<T>(renderer: Parameters<TestUI["custom"]>[0]) {
				return options.custom ? options.custom<T>(renderer as never) : (customResult as T | undefined);
			},
		},
		sessionManager: options.sessionManager ?? {
			getBranch() {
				return branchEntries;
			},
			getEntries() {
				return allEntries;
			},
			getSessionDir() {
				return "";
			},
			getSessionFile() {
				return undefined;
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

function appendAssistant(manager: SessionManager): void {
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

test("a fresh-session stash survives restarting before the first assistant reply", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-fresh-session-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const harness = createHarness((type, data) => manager.appendCustomEntry(type, data));
		const context = createContext({
			cwd,
			sessionManager: manager,
			mode: "tui",
			editorText: "draft I must not lose",
		});

		await harness.events.get("session_start")?.({}, context.ctx);
		await harness.shortcuts.get("ctrl+shift+s")?.handler(context.ctx);
		await harness.commands.get("stash")?.handler("second draft", context.ctx);

		assert.equal(context.editorText, "");
		const originalFile = manager.getSessionFile()!;
		const neededRecovery = !existsSync(originalFile);
		const resumed = SessionManager.continueRecent(cwd, sessionDir);
		const expected = ["second draft", "draft I must not lose"];
		assert.deepEqual(hydrateState(resumed.getBranch()).drafts, expected);
		assert.equal(resumed.getSessionFile() !== originalFile, neededRecovery);

		appendAssistant(manager);
		await harness.events.get("agent_end")?.({}, context.ctx);
		if (neededRecovery) assert.equal(existsSync(resumed.getSessionFile()!), true);
		assert.deepEqual(hydrateState(SessionManager.open(originalFile).getBranch()).drafts, expected);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an opened recovery session is kept when the original session saves", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-open-recovery-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const harness = createHarness((type, data) => manager.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: manager, mode: "tui" });
		await harness.commands.get("stash")?.handler("original draft", context.ctx);
		if (existsSync(manager.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const recovered = SessionManager.continueRecent(cwd, sessionDir);
		const recoveryFile = recovered.getSessionFile()!;
		const recoveredHarness = createHarness((type, data) => recovered.appendCustomEntry(type, data));
		const recoveredContext = createContext({ cwd, sessionManager: recovered, mode: "tui" });
		await recoveredHarness.events.get("session_start")?.({}, recoveredContext.ctx);

		appendAssistant(manager);
		await harness.events.get("agent_end")?.({}, context.ctx);
		assert.equal(existsSync(recoveryFile), true);
		await recoveredHarness.commands.get("stash")?.handler("independent draft", recoveredContext.ctx);
		assert.deepEqual(hydrateState(SessionManager.open(recoveryFile).getBranch()).drafts, [
			"independent draft", "original draft",
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("stashing again does not overwrite an opened recovery session", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-shared-recovery-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const original = SessionManager.create(cwd, sessionDir);
		const originalHarness = createHarness((type, data) => original.appendCustomEntry(type, data));
		const originalContext = createContext({ cwd, sessionManager: original, mode: "tui" });
		await originalHarness.commands.get("stash")?.handler("first draft", originalContext.ctx);
		if (existsSync(original.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const opened = SessionManager.continueRecent(cwd, sessionDir);
		const openedFile = opened.getSessionFile()!;
		const openedHarness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const openedContext = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await openedHarness.events.get("session_start")?.({}, openedContext.ctx);
		await openedHarness.commands.get("stash")?.handler("other session", openedContext.ctx);

		const future = new Date(Date.now() + 1_000);
		utimesSync(openedFile, future, future);
		await originalHarness.commands.get("stash")?.handler("second draft", originalContext.ctx);
		assert.deepEqual(hydrateState(SessionManager.open(openedFile).getBranch()).drafts, [
			"other session", "first draft",
		]);
		const latest = SessionManager.continueRecent(cwd, sessionDir);
		assert.notEqual(latest.getSessionFile(), openedFile);
		assert.ok(statSync(latest.getSessionFile()!).mtimeMs > statSync(openedFile).mtimeMs);
		assert.deepEqual(hydrateState(latest.getBranch()).drafts, ["second draft", "first draft"]);

		const other = SessionManager.create(cwd, sessionDir);
		appendAssistant(other);
		const later = (statSync(openedFile).mtimeMs + 0.5) / 1000;
		utimesSync(other.getSessionFile()!, later, later);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), other.getSessionFile());

		appendAssistant(original);
		await originalHarness.events.get("agent_end")?.({}, originalContext.ctx);
		assert.equal(existsSync(openedFile), true);
		assert.equal(existsSync(latest.getSessionFile()!), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a recovery loaded before the original saves stays writable", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-opening-recovery-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const original = SessionManager.create(cwd, sessionDir);
		const originalHarness = createHarness((type, data) => original.appendCustomEntry(type, data));
		const originalContext = createContext({ cwd, sessionManager: original, mode: "tui" });
		await originalHarness.commands.get("stash")?.handler("first draft", originalContext.ctx);
		if (existsSync(original.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const opening = SessionManager.continueRecent(cwd, sessionDir);
		const openingFile = opening.getSessionFile()!;
		await originalHarness.commands.get("stash")?.handler("new original draft", originalContext.ctx);
		assert.equal(existsSync(openingFile), true);
		appendAssistant(original);
		await originalHarness.events.get("agent_end")?.({}, originalContext.ctx);
		assert.equal(existsSync(openingFile), true);
		const openingHarness = createHarness((type, data) => opening.appendCustomEntry(type, data));
		const openingContext = createContext({ cwd, sessionManager: opening, mode: "tui" });
		await openingHarness.events.get("session_start")?.({}, openingContext.ctx);
		await openingHarness.commands.get("stash")?.handler("other window", openingContext.ctx);
		assert.deepEqual(hydrateState(SessionManager.open(openingFile).getBranch()).drafts, [
			"other window", "first draft",
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("opening an older recovery does not make it the latest session", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-opening-order-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const original = SessionManager.create(cwd, sessionDir);
		const originalHarness = createHarness((type, data) => original.appendCustomEntry(type, data));
		const originalContext = createContext({ cwd, sessionManager: original, mode: "tui" });
		await originalHarness.commands.get("stash")?.handler("first draft", originalContext.ctx);
		if (existsSync(original.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const opened = SessionManager.continueRecent(cwd, sessionDir);
		await originalHarness.commands.get("stash")?.handler("second draft", originalContext.ctx);
		const latestFile = SessionManager.continueRecent(cwd, sessionDir).getSessionFile();
		const openedHarness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const openedContext = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await openedHarness.events.get("session_start")?.({}, openedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), latestFile);
		await openedHarness.events.get("session_start")?.({}, openedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), latestFile);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("clearing the latest recovery stays cleared on continue", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-clear-latest-recovery-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const original = SessionManager.create(cwd, sessionDir);
		const harness = createHarness((type, data) => original.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: original, mode: "tui" });
		await harness.commands.get("stash")?.handler("first draft", context.ctx);
		if (existsSync(original.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}
		const firstRecovery = SessionManager.continueRecent(cwd, sessionDir).getSessionFile()!;
		const future = new Date(Date.now() + 1_000);
		utimesSync(firstRecovery, future, future);
		await harness.commands.get("stash")?.handler("second draft", context.ctx);

		const recovered = SessionManager.continueRecent(cwd, sessionDir);
		const recoveredHarness = createHarness((type, data) => recovered.appendCustomEntry(type, data));
		const recoveredContext = createContext({
			cwd, sessionManager: recovered, mode: "tui", customResult: { action: "clear" },
		});
		await recoveredHarness.events.get("session_start")?.({}, recoveredContext.ctx);
		await recoveredHarness.commands.get("stash-list")?.handler("", recoveredContext.ctx);

		assert.deepEqual(hydrateState(SessionManager.continueRecent(cwd, sessionDir).getBranch()).drafts, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("clearing the unsaved original keeps an opened recovery separate", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-clear-original-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const original = SessionManager.create(cwd, sessionDir);
		const harness = createHarness((type, data) => original.appendCustomEntry(type, data));
		const context = createContext({
			cwd, sessionManager: original, mode: "tui", customResult: { action: "clear" },
		});
		await harness.commands.get("stash")?.handler("first draft", context.ctx);
		if (existsSync(original.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const opened = SessionManager.continueRecent(cwd, sessionDir);
		const openedFile = opened.getSessionFile()!;
		const openedHarness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const openedContext = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await openedHarness.events.get("session_start")?.({}, openedContext.ctx);
		await openedHarness.commands.get("stash")?.handler("other window", openedContext.ctx);

		await harness.commands.get("stash-list")?.handler("", context.ctx);
		assert.deepEqual(hydrateState(SessionManager.continueRecent(cwd, sessionDir).getBranch()).drafts, []);
		assert.deepEqual(hydrateState(SessionManager.open(openedFile).getBranch()).drafts, [
			"other window", "first draft",
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a late recovery startup cannot undo an original clear", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-late-recovery-start-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const original = SessionManager.create(cwd, sessionDir);
		const harness = createHarness((type, data) => original.appendCustomEntry(type, data));
		const context = createContext({
			cwd, sessionManager: original, mode: "tui", customResult: { action: "clear" },
		});
		await harness.commands.get("stash")?.handler("discard me", context.ctx);
		if (existsSync(original.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const opening = SessionManager.continueRecent(cwd, sessionDir);
		await harness.commands.get("stash-list")?.handler("", context.ctx);
		const emptyRecovery = SessionManager.continueRecent(cwd, sessionDir).getSessionFile();
		const openingHarness = createHarness((type, data) => opening.appendCustomEntry(type, data));
		const openingContext = createContext({ cwd, sessionManager: opening, mode: "tui" });
		await openingHarness.events.get("session_start")?.({}, openingContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), emptyRecovery);

		appendAssistant(original);
		await harness.events.get("agent_end")?.({}, context.ctx);
		assert.deepEqual(hydrateState(SessionManager.open(original.getSessionFile()!).getBranch()).drafts, []);
		assert.equal(existsSync(emptyRecovery!), true);
		assert.deepEqual(hydrateState(SessionManager.continueRecent(cwd, sessionDir).getBranch()).drafts, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent end does not overtake a later recovery edit", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-later-recovery-edit-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const original = SessionManager.create(cwd, sessionDir);
		const harness = createHarness((type, data) => original.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: original, mode: "tui" });
		await harness.commands.get("stash")?.handler("first draft", context.ctx);
		if (existsSync(original.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const opened = SessionManager.continueRecent(cwd, sessionDir);
		const openedHarness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const openedContext = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await openedHarness.events.get("session_start")?.({}, openedContext.ctx);
		appendAssistant(original);
		await openedHarness.commands.get("stash")?.handler("later edit", openedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), opened.getSessionFile());

		await harness.events.get("agent_end")?.({}, context.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), opened.getSessionFile());
		assert.deepEqual(hydrateState(SessionManager.open(opened.getSessionFile()!).getBranch()).drafts, [
			"later edit", "first draft",
		]);

		const future = new Date(Date.now() + 1_000);
		utimesSync(opened.getSessionFile()!, future, future);
		const other = SessionManager.create(cwd, sessionDir);
		appendAssistant(other);
		const otherHarness = createHarness((type, data) => other.appendCustomEntry(type, data));
		const otherContext = createContext({ cwd, sessionManager: other, mode: "tui" });
		await otherHarness.commands.get("stash")?.handler("newer session", otherContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), other.getSessionFile());
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saving one session does not delete another session's recovery", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-recovery-ownership-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const other = SessionManager.open(join(sessionDir, "foo-bar.jsonl"), sessionDir, cwd);
		const otherHarness = createHarness((type, data) => other.appendCustomEntry(type, data));
		const otherContext = createContext({ cwd, sessionManager: other, mode: "tui" });
		await otherHarness.commands.get("stash")?.handler("other draft", otherContext.ctx);
		if (existsSync(other.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}
		const otherRecovery = SessionManager.continueRecent(cwd, sessionDir).getSessionFile()!;

		const first = SessionManager.open(join(sessionDir, "foo.jsonl"), sessionDir, cwd);
		const firstHarness = createHarness((type, data) => first.appendCustomEntry(type, data));
		const firstContext = createContext({ cwd, sessionManager: first, mode: "tui" });
		await firstHarness.commands.get("stash")?.handler("first draft", firstContext.ctx);
		const firstRecovery = SessionManager.continueRecent(cwd, sessionDir).getSessionFile()!;

		appendAssistant(first);
		await firstHarness.events.get("agent_end")?.({}, firstContext.ctx);
		assert.equal(existsSync(firstRecovery), true);
		assert.equal(existsSync(otherRecovery), true);
		assert.deepEqual(hydrateState(SessionManager.open(otherRecovery).getBranch()).drafts, ["other draft"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("leaving an unsaved stash branch does not delete its recovery", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-unsaved-branch-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const earlier = manager.appendModelChange("openai", "test");
		const harness = createHarness((type, data) => manager.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: manager, mode: "tui" });
		await harness.commands.get("stash")?.handler("keep this draft", context.ctx);
		if (existsSync(manager.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const recovery = SessionManager.continueRecent(cwd, sessionDir).getSessionFile()!;
		manager.branch(earlier);
		await harness.events.get("session_tree")?.({}, context.ctx);
		await harness.events.get("agent_end")?.({}, context.ctx);
		assert.equal(existsSync(recovery), true);
		await harness.commands.get("stash")?.handler("other branch draft", context.ctx);
		assert.equal(existsSync(recovery), true);
		const other = SessionManager.continueRecent(cwd, sessionDir);
		assert.deepEqual(hydrateState(other.getBranch()).drafts, ["other branch draft"]);
		await harness.events.get("session_shutdown")?.({}, context.ctx);
		assert.equal(existsSync(recovery), true);
		assert.deepEqual(hydrateState(SessionManager.open(recovery).getBranch()).drafts, ["keep this draft"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a failed recovery write leaves the editor draft intact", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-recovery-failure-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		rmSync(sessionDir, { recursive: true });
		writeFileSync(sessionDir, "not a directory");
		const harness = createHarness((type, data) => manager.appendCustomEntry(type, data));
		const context = createContext({
			cwd, sessionManager: manager, mode: "tui", editorText: "keep this draft",
		});

		await harness.events.get("session_start")?.({}, context.ctx);
		await assert.rejects(harness.shortcuts.get("ctrl+shift+s")!.handler(context.ctx), { code: "ENOTDIR" });
		assert.equal(context.editorText, "keep this draft");

		context.ctx.ui.setEditorText("");
		await assert.rejects(harness.commands.get("stash")!.handler("keep explicit text", context.ctx), { code: "ENOTDIR" });
		assert.equal(context.editorText, "keep explicit text");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("clearing an early stash does not resurrect it on restart", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-clear-recovery-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const harness = createHarness((type, data) => manager.appendCustomEntry(type, data));
		const context = createContext({
			cwd, sessionManager: manager, mode: "tui", customResult: { action: "clear" },
		});

		await harness.commands.get("stash")?.handler("discard me", context.ctx);
		const recovery = SessionManager.continueRecent(cwd, sessionDir).getSessionFile()!;
		assert.equal(existsSync(recovery), true);

		await harness.commands.get("stash-list")?.handler("", context.ctx);
		assert.deepEqual(hydrateState(SessionManager.continueRecent(cwd, sessionDir).getBranch()).drafts, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/stash preserves explicit whitespace exactly", async () => {
	const harness = createHarness();
	const context = createContext({
		branchEntries: [],
		allEntries: [stashSnapshot("ignored global draft")],
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

test("state mutations remain serialized while a picker is pending", async () => {
	const harness = createHarness();
	let pickerOpened!: () => void;
	let resolvePicker!: (result: unknown) => void;
	const opened = new Promise<void>((resolve) => {
		pickerOpened = resolve;
	});
	const pickerResult = new Promise<unknown>((resolve) => {
		resolvePicker = resolve;
	});
	const context = createContext({
		branchEntries: [stashSnapshot("latest", "older")],
		mode: "tui",
		theme: { fg: (_name, value) => value, bold: (value) => value },
		custom: async <T>(_renderer: Parameters<TestUI["custom"]>[0]) => {
			pickerOpened();
			return (await pickerResult) as T;
		},
	});

	await harness.events.get("session_start")?.({}, context.ctx);
	const picker = harness.commands.get("stash-list")?.handler("", context.ctx);
	await opened;
	const queuedStash = harness.commands.get("stash")?.handler("queued", context.ctx);
	assert.equal(harness.appended.length, 0);

	resolvePicker({ action: "cancel" });
	await Promise.all([picker, queuedStash]);
	assert.deepEqual(harness.appended.at(-1), {
		type: STASH_ENTRY_TYPE,
		data: { drafts: ["queued", "latest", "older"] },
	});
});

test("session shutdown closes a rendered picker, clears status, and invalidates queued mutations", async () => {
	initTheme();
	const harness = createHarness();
	let pickerOpened!: () => void;
	let pickerDoneValue: unknown;
	const opened = new Promise<void>((resolve) => {
		pickerOpened = resolve;
	});
	const context = createContext({
		branchEntries: [stashSnapshot("latest", "older")],
		mode: "tui",
		theme: { fg: (_name, value) => value, bold: (value) => value },
		custom: <T>(renderer: Parameters<TestUI["custom"]>[0]) =>
			new Promise<T | undefined>((resolve) => {
				renderer(
					{ requestRender() {} },
					{ fg: (_name: string, value: string) => value, bold: (value: string) => value },
					{},
					(value) => {
						pickerDoneValue = value;
						resolve(value as T);
					},
				);
				pickerOpened();
			}),
	});

	await harness.events.get("session_start")?.({}, context.ctx);
	const picker = harness.commands.get("stash-list")?.handler("", context.ctx);
	await opened;
	const queuedStash = harness.commands.get("stash")?.handler("must not survive shutdown", context.ctx);

	await harness.events.get("session_shutdown")?.({}, context.ctx);
	await Promise.all([picker, queuedStash]);

	assert.deepEqual(pickerDoneValue, { action: "cancel" });
	assert.deepEqual(context.statuses.at(-1), { key: "pi-stash", text: undefined });
	assert.equal(harness.appended.length, 0);

	context.setBranchEntries([]);
	await harness.events.get("session_start")?.({}, context.ctx);
	await harness.commands.get("stash")?.handler("fresh after replacement", context.ctx);
	assert.deepEqual(harness.appended.at(-1), {
		type: STASH_ENTRY_TYPE,
		data: { drafts: ["fresh after replacement"] },
	});
});

test("session replacement aborts and dismisses a pending TUI confirmation without stale state", async () => {
	const harness = createHarness();
	let confirmationOpened!: () => void;
	let confirmationSignal: AbortSignal | undefined;
	let dismissed = false;
	const opened = new Promise<void>((resolve) => {
		confirmationOpened = resolve;
	});
	const context = createContext({
		branchEntries: [stashSnapshot("latest", "older")],
		mode: "tui",
		theme: { fg: (_name, value) => value, bold: (value) => value },
		customResult: { action: "clear" },
		confirm: (_title, _message, options) => {
			confirmationSignal = options?.signal;
			assert.ok(confirmationSignal);
			confirmationOpened();
			return new Promise<boolean>((resolve) => {
				confirmationSignal?.addEventListener(
					"abort",
					() => {
						dismissed = true;
						resolve(true);
					},
					{ once: true },
				);
			});
		},
	});

	await harness.events.get("session_start")?.({}, context.ctx);
	const pendingList = harness.commands.get("stash-list")?.handler("", context.ctx);
	await opened;
	assert.equal(confirmationSignal?.aborted, false);

	context.setBranchEntries([stashSnapshot("replacement")]);
	await harness.events.get("session_start")?.({}, context.ctx);
	await pendingList;

	assert.equal(confirmationSignal?.aborted, true);
	assert.equal(dismissed, true);
	assert.equal(harness.appended.length, 0);
	assert.equal(context.notifications.some((entry) => entry.message === "Cleared stashed drafts"), false);
	await harness.commands.get("stash")?.handler("fresh", context.ctx);
	assert.deepEqual(harness.appended.at(-1), {
		type: STASH_ENTRY_TYPE,
		data: { drafts: ["fresh", "replacement"] },
	});
});

test("session tree and shutdown invalidate pending RPC restore confirmations without stale effects", async () => {
	for (const eventName of ["session_tree", "session_shutdown"] as const) {
		const harness = createHarness();
		let confirmationOpened!: () => void;
		let confirmationSignal: AbortSignal | undefined;
		let abortObserved = false;
		const opened = new Promise<void>((resolve) => {
			confirmationOpened = resolve;
		});
		const context = createContext({
			branchEntries: [stashSnapshot("latest")],
			mode: "rpc",
			confirm: (_title, _message, options) => {
				confirmationSignal = options?.signal;
				assert.ok(confirmationSignal);
				confirmationOpened();
				return new Promise<boolean>((resolve) => {
					confirmationSignal?.addEventListener(
						"abort",
						() => {
							abortObserved = true;
							resolve(eventName === "session_shutdown");
						},
						{ once: true },
					);
				});
			},
		});

		await harness.events.get("session_start")?.({}, context.ctx);
		const pendingRestore = harness.shortcuts.get("ctrl+shift+r")?.handler(context.ctx);
		await opened;
		assert.equal(confirmationSignal?.aborted, false, eventName);

		context.setBranchEntries([stashSnapshot("replacement")]);
		await harness.events.get(eventName)?.({}, context.ctx);
		await pendingRestore;

		assert.equal(confirmationSignal?.aborted, true, eventName);
		assert.equal(abortObserved, true, eventName);
		assert.equal(context.editorText, "", eventName);
		assert.equal(harness.appended.length, 0, eventName);
		assert.equal(
			context.notifications.some((entry) => entry.message === "Restore cancelled"),
			false,
			eventName,
		);
	}
});

test("checkpoint qualifies existing branch state without mutating it", async () => {
	const harness = createHarness();
	const context = createContext({ branchEntries: [stashSnapshot("saved")], editorText: "native-owned draft" });
	await harness.events.get("session_start")?.({}, context.ctx);
	const checkpoint = harness.events.get("session_checkpoint");
	assert.ok(checkpoint);
	assert.deepEqual(await checkpoint({}, context.ctx), { sleepReady: true });
	assert.equal(context.editorText, "native-owned draft", "native host, not stash, guards editor drafts");
	assert.equal(harness.appended.length, 0, "checkpoint does not rewrite or auto-stash");
	context.setBranchEntries([]);
	assert.deepEqual(await checkpoint({}, context.ctx), {
		sleepReady: false, reason: "Stash state differs from the selected branch",
	});
});

test("checkpoint refuses a live picker without cancelling it", async () => {
	const harness = createHarness();
	let opened!: () => void;
	let finish!: (value: unknown) => void;
	const waiting = new Promise<void>((resolve) => { opened = resolve; });
	const result = new Promise<unknown>((resolve) => { finish = resolve; });
	const context = createContext({
		branchEntries: [stashSnapshot("saved")], mode: "tui",
		custom: async <T>() => { opened(); return (await result) as T; },
	});
	await harness.events.get("session_start")?.({}, context.ctx);
	const command = harness.commands.get("stash-list")!.handler("", context.ctx);
	await waiting;
	assert.deepEqual(await harness.events.get("session_checkpoint")!({}, context.ctx), {
		sleepReady: false, reason: "Stash interaction is still live",
	});
	assert.equal(harness.appended.length, 0);
	finish({ action: "cancel" });
	await command;
	assert.deepEqual(await harness.events.get("session_checkpoint")!({}, context.ctx), { sleepReady: true });
});

test("/stash ignores whitespace-only explicit text", async () => {
	const harness = createHarness();
	const context = createContext({ branchEntries: [], allEntries: [] });

	await harness.commands.get("stash")?.handler("   ", context.ctx);

	assert.equal(harness.appended.length, 0);
	assert.equal(context.notifications.some((entry) => entry.message === "Nothing to stash"), true);
});
