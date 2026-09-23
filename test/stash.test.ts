/**
 * Purpose: Verify branch-aware and RPC-safe behavior for the pi-stash extension entrypoint.
 * Responsibilities: Cover branch rehydration, explicit `/stash` argument preservation, and RPC fallbacks when custom UI is unavailable.
 * Scope: Integration-style tests around `extensions/stash.ts` with mocked pi extension APIs.
 * Usage: Run with `npm test` or `npm run test:node22`; both commands transpile the test bundle into `.tmp/test-dist/` first.
 * Invariants/Assumptions: Mocked contexts emulate the extension API surface closely enough to catch stash-state regressions without spinning up a full pi runtime.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
	model?: { provider: string; id: string };
	ui: TestUI;
	sessionManager: {
		getBranch(): PersistedEntry[];
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
	editorText?: string;
	theme?: TestTheme;
	customResult?: unknown;
	custom?: TestUI["custom"];
	confirmResult?: boolean;
	confirm?: (title: string, message: string, options?: TestDialogOptions) => Promise<boolean>;
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	cwd?: string;
	model?: TestContext["model"];
	sessionManager?: TestContext["sessionManager"];
}) {
	const notifications: Notification[] = [];
	const statuses: StatusUpdate[] = [];
	let editorText = options.editorText ?? "";
	let branchEntries = options.branchEntries ?? [];
	const customResult = options.customResult;
	const confirmResult = options.confirmResult ?? true;

	const ctx: TestContext = {
		mode: options.mode ?? (options.hasUI === false ? "print" : options.theme ? "tui" : "rpc"),
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? process.cwd(),
		model: options.model,
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
		recovered.appendModelChange("openai", "test");
		recovered.appendThinkingLevelChange("off");
		const recoveredHarness = createHarness((type, data) => recovered.appendCustomEntry(type, data));
		const recoveredContext = createContext({ cwd, sessionManager: recovered, mode: "tui" });
		await recoveredHarness.events.get("session_start")?.({}, recoveredContext.ctx);
		appendAssistant(recovered);
		const later = new Date(Date.now() + 1_000);
		utimesSync(recoveryFile, later, later);
		const activityMtime = statSync(recoveryFile).mtimeMs;
		await recoveredHarness.events.get("session_start")?.({}, recoveredContext.ctx);
		assert.equal(statSync(recoveryFile).mtimeMs, activityMtime);

		appendAssistant(manager);
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

		const future = (Date.now() + 1_000.75) / 1000;
		utimesSync(openedFile, future, future);
		await originalHarness.commands.get("stash")?.handler("second draft", originalContext.ctx);
		assert.deepEqual(hydrateState(SessionManager.open(openedFile).getBranch()).drafts, [
			"other session", "first draft",
		]);
		const latest = SessionManager.continueRecent(cwd, sessionDir);
		assert.notEqual(latest.getSessionFile(), openedFile);
		const openedStat = statSync(openedFile);
		const latestStat = statSync(latest.getSessionFile()!);
		assert.ok(latestStat.mtime.getTime() > openedStat.mtime.getTime());
		assert.deepEqual(hydrateState(latest.getBranch()).drafts, ["second draft", "first draft"]);

		const other = SessionManager.create(cwd, sessionDir);
		appendAssistant(other);
		const later = (latestStat.mtimeMs + 0.5) / 1000;
		utimesSync(other.getSessionFile()!, later, later);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), other.getSessionFile());

		appendAssistant(original);
		assert.equal(existsSync(openedFile), true);
		assert.equal(existsSync(latest.getSessionFile()!), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a loaded recovery stays writable after the original saves and another window quits", async (t) => {
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

		const delayed = SessionManager.open(openingFile);
		delayed.appendModelChange("openai", "test");
		delayed.appendThinkingLevelChange("off");
		const delayedHarness = createHarness((type, data) => delayed.appendCustomEntry(type, data));
		const delayedContext = createContext({ cwd, sessionManager: delayed, mode: "tui" });
		const second = SessionManager.open(openingFile);
		const secondHarness = createHarness((type, data) => second.appendCustomEntry(type, data));
		const secondContext = createContext({ cwd, sessionManager: second, mode: "tui" });
		await secondHarness.events.get("session_start")?.({}, secondContext.ctx);
		await secondHarness.commands.get("stash")?.handler("second window draft", secondContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), openingFile);
		await delayedHarness.events.get("session_start")?.({}, delayedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), openingFile);
		await openingHarness.events.get("session_shutdown")?.({}, openingContext.ctx);
		assert.deepEqual(hydrateState(SessionManager.open(openingFile).getBranch()).drafts, [
			"second window draft", "other window", "first draft",
		]);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), openingFile);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("opening an older recovery does not promote it, but renaming it does", async (t) => {
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
		opened.appendModelChange("openai", "test");
		opened.appendThinkingLevelChange("off");
		const future = new Date(statSync(latestFile!).mtimeMs + 1_000);
		utimesSync(opened.getSessionFile()!, future, future);
		const openedHarness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const openedContext = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await openedHarness.events.get("session_start")?.({}, openedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), latestFile);
		await openedHarness.events.get("session_start")?.({}, openedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), latestFile);

		const overlapping = SessionManager.open(opened.getSessionFile()!);
		overlapping.appendModelChange("openai", "test");
		overlapping.appendThinkingLevelChange("off");
		const overlappingHarness = createHarness((type, data) => overlapping.appendCustomEntry(type, data));
		const overlappingContext = createContext({ cwd, sessionManager: overlapping, mode: "tui" });
		await openedHarness.events.get("session_shutdown")?.({}, openedContext.ctx);
		await overlappingHarness.events.get("session_start")?.({}, overlappingContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), latestFile);

		await new Promise((resolve) => setTimeout(resolve, 20));
		const renamed = SessionManager.open(opened.getSessionFile()!);
		renamed.appendSessionInfo("renamed");
		renamed.appendModelChange("openai", "test");
		renamed.appendThinkingLevelChange("off");
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), renamed.getSessionFile());
		const renamedHarness = createHarness((type, data) => renamed.appendCustomEntry(type, data));
		const renamedContext = createContext({ cwd, sessionManager: renamed, mode: "tui" });
		await renamedHarness.events.get("session_start")?.({}, renamedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), renamed.getSessionFile());
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a native recovery edit stays recent while another window opens it", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-concurrent-native-edit-"));
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
		const older = SessionManager.continueRecent(cwd, sessionDir).getSessionFile()!;
		await originalHarness.commands.get("stash")?.handler("second draft", originalContext.ctx);
		const latestFile = SessionManager.continueRecent(cwd, sessionDir).getSessionFile()!;

		const edited = SessionManager.open(older);
		edited.appendModelChange("openai", "startup-model");
		edited.appendThinkingLevelChange("off");
		const editedHarness = createHarness((type, data) => edited.appendCustomEntry(type, data));
		const editedContext = createContext({ cwd, sessionManager: edited, mode: "tui" });
		await editedHarness.events.get("session_start")?.({}, editedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), latestFile);

		edited.appendModelChange("openai", "user-selected-model");
		await editedHarness.events.get("model_select")?.({}, editedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), older);

		const otherWindow = SessionManager.open(older);
		otherWindow.appendModelChange("openai", "startup-model");
		otherWindow.appendThinkingLevelChange("off");
		const otherHarness = createHarness((type, data) => otherWindow.appendCustomEntry(type, data));
		const otherContext = createContext({ cwd, sessionManager: otherWindow, mode: "tui" });
		await otherHarness.events.get("session_start")?.({}, otherContext.ctx);
		await editedHarness.events.get("session_shutdown")?.({}, editedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), older);

		const resumed = SessionManager.open(older);
		resumed.appendModelChange("openai", "startup-model");
		resumed.appendThinkingLevelChange("off");
		const resumedHarness = createHarness((type, data) => resumed.appendCustomEntry(type, data));
		const resumedContext = createContext({ cwd, sessionManager: resumed, mode: "tui" });
		await resumedHarness.events.get("session_start")?.({}, resumedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), older);
		assert.deepEqual(hydrateState(resumed.getBranch()).drafts, ["first draft"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a conversation on another recovery branch is not backdated", async () => {
	for (const activity of ["assistant", "custom_message"] as const) {
		const cwd = mkdtempSync(join(tmpdir(), "pi-stash-concurrent-message-"));
		try {
			const sessionDir = join(cwd, "sessions");
			const file = join(sessionDir, "shared-pi-stash-recovery.jsonl");
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(file, "");
			const recovery = SessionManager.open(file, sessionDir, cwd);
			const stashId = recovery.appendCustomEntry(STASH_ENTRY_TYPE, {
				drafts: ["draft"], recoveryMtimeMs: Date.now() - 10_000,
			});
			const other = SessionManager.create(cwd, sessionDir);
			appendAssistant(other);
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (activity === "assistant") appendAssistant(recovery);
			else recovery.appendCustomMessageEntry("other-extension", "conversation update", false);
			recovery.branch(stashId);
			recovery.appendModelChange("openai", "startup-model");
			recovery.appendThinkingLevelChange("off");
			assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), file);

			const harness = createHarness((type, data) => recovery.appendCustomEntry(type, data));
			const context = createContext({ cwd, sessionManager: recovery, mode: "tui" });
			await harness.events.get("session_start")?.({}, context.ctx);
			assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), file, activity);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

test("an older conversation on another branch does not promote a recovery", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-older-branch-message-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const file = join(sessionDir, "older-pi-stash-recovery.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(file, "");
		const recovery = SessionManager.open(file, sessionDir, cwd);
		const stashId = recovery.appendCustomEntry(STASH_ENTRY_TYPE, {
			drafts: ["old draft"], recoveryMtimeMs: Date.now(),
		});
		appendAssistant(recovery);
		recovery.branch(stashId);
		recovery.appendCustomEntry(STASH_ENTRY_TYPE, {
			drafts: ["old branch draft"], recoveryMtimeMs: Date.now(),
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const newer = SessionManager.create(cwd, sessionDir);
		appendAssistant(newer);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), newer.getSessionFile());

		const opened = SessionManager.open(file);
		opened.appendModelChange("openai", "startup-model");
		opened.appendThinkingLevelChange("off");
		const harness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await harness.events.get("session_start")?.({}, context.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), newer.getSessionFile());
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a system-only recovery branch does not promote an old conversation", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-system-only-branch-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const file = join(sessionDir, "system-pi-stash-recovery.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(file, "");
		const recovery = SessionManager.open(file, sessionDir, cwd);
		recovery.appendCustomEntry(STASH_ENTRY_TYPE, { drafts: ["old draft"], recoveryMtimeMs: Date.now() });
		const systemId = recovery.appendMessage({ role: "system", content: "prompt", timestamp: Date.now() });
		appendAssistant(recovery);
		recovery.branch(systemId);
		recovery.appendCustomEntry(STASH_ENTRY_TYPE, {
			drafts: ["old branch draft"], recoveryMtimeMs: Date.now(),
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const newer = SessionManager.create(cwd, sessionDir);
		appendAssistant(newer);

		const opened = SessionManager.open(file);
		opened.appendThinkingLevelChange("off");
		const harness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await harness.events.get("session_start")?.({}, context.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), newer.getSessionFile());
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a conversation branched before startup thinking does not promote an old recovery", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-before-thinking-branch-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const file = join(sessionDir, "branched-pi-stash-recovery.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(file, "");
		const recovery = SessionManager.open(file, sessionDir, cwd);
		const stashId = recovery.appendCustomEntry(STASH_ENTRY_TYPE, {
			drafts: ["old draft"], recoveryMtimeMs: Date.now(),
		});
		recovery.appendModelChange("openai", "startup-model");
		recovery.appendThinkingLevelChange("off");
		recovery.branch(stashId);
		recovery.appendMessage({ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now() });
		appendAssistant(recovery);
		assert.equal(recovery.getBranch().some((entry) => entry.type === "thinking_level_change"), false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const newer = SessionManager.create(cwd, sessionDir);
		appendAssistant(newer);

		const opened = SessionManager.open(file);
		opened.appendThinkingLevelChange("off");
		const harness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await harness.events.get("session_start")?.({}, context.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), newer.getSessionFile());
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("omitted conversation entries do not promote an old recovery", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-omitted-conversation-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const file = join(sessionDir, "edited-pi-stash-recovery.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(file, "");
		const recovery = SessionManager.open(file, sessionDir, cwd);
		const edit = (recovery as SessionManager & {
			appendContextEdit?: (targetId: string, replacement: null) => string;
		}).appendContextEdit;
		if (!edit) {
			t.skip("this Pi host has no context edits");
			return;
		}
		recovery.appendCustomEntry(STASH_ENTRY_TYPE, { drafts: ["old draft"], recoveryMtimeMs: Date.now() });
		recovery.appendThinkingLevelChange("off");
		const userId = recovery.appendMessage({
			role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now(),
		});
		appendAssistant(recovery);
		const assistantId = recovery.getLeafId()!;
		edit.call(recovery, userId, null);
		edit.call(recovery, assistantId, null);
		assert.equal(recovery.buildSessionContext().messages.some((message) => message.role !== "system"), false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const newer = SessionManager.create(cwd, sessionDir);
		appendAssistant(newer);

		const opened = SessionManager.open(file);
		opened.appendModelChange("openai", "startup-model");
		opened.appendThinkingLevelChange("off");
		const harness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await harness.events.get("session_start")?.({}, context.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), newer.getSessionFile());
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an imported recovery timestamp cannot pin recent sessions", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-imported-time-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const original = SessionManager.create(cwd, sessionDir);
		const harness = createHarness((type, data) => original.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: original, mode: "tui" });
		await harness.commands.get("stash")?.handler("old draft", context.ctx);
		if (existsSync(original.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const file = SessionManager.continueRecent(cwd, sessionDir).getSessionFile()!;
		const entries = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const snapshot = entries.find((entry) => entry.customType === STASH_ENTRY_TYPE);
		snapshot.data.recoveryMtimeMs = Date.parse("2100-01-01");
		writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const imported = SessionManager.open(file);
		const importedHarness = createHarness((type, data) => imported.appendCustomEntry(type, data));
		const importedContext = createContext({ cwd, sessionManager: imported, mode: "tui" });
		await importedHarness.events.get("session_start")?.({}, importedContext.ctx);

		const newer = SessionManager.create(cwd, sessionDir);
		appendAssistant(newer);
		const later = new Date(Date.now() + 1_000);
		utimesSync(newer.getSessionFile()!, later, later);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), newer.getSessionFile());
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an upgraded recovery keeps native edits made after its original stash", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-legacy-activity-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const file = join(sessionDir, "legacy-pi-stash-recovery.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(file, "");
		const legacy = SessionManager.open(file, sessionDir, cwd);
		legacy.appendSessionInfo("Stashed drafts");
		legacy.appendCustomEntry(STASH_ENTRY_TYPE, { drafts: ["legacy draft"] });
		await new Promise((resolve) => setTimeout(resolve, 20));
		appendAssistant(SessionManager.create(cwd, sessionDir));

		await new Promise((resolve) => setTimeout(resolve, 20));
		legacy.appendCustomEntry("pi-stash-recovery-opened", undefined);
		legacy.appendModelChange("openai", "user-selected-model");
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), file);

		const opened = SessionManager.open(file);
		opened.appendModelChange("openai", "startup-model");
		opened.appendThinkingLevelChange("off");
		const harness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const context = createContext({
			cwd, sessionManager: opened, mode: "tui", model: { provider: "openai", id: "startup-model" },
		});
		await harness.events.get("session_start")?.({}, context.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), file);
		await harness.events.get("session_shutdown")?.({}, context.ctx);

		const resumed = SessionManager.open(file);
		resumed.appendModelChange("openai", "startup-model");
		resumed.appendThinkingLevelChange("off");
		const resumedHarness = createHarness((type, data) => resumed.appendCustomEntry(type, data));
		const resumedContext = createContext({
			cwd, sessionManager: resumed, mode: "tui", model: { provider: "openai", id: "startup-model" },
		});
		await resumedHarness.events.get("session_start")?.({}, resumedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), file);
		assert.deepEqual(hydrateState(resumed.getBranch()).drafts, ["legacy draft"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("opening an upgraded recovery twice does not make it recent", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-legacy-opening-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const file = join(sessionDir, "legacy-pi-stash-recovery.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(file, "");
		const legacy = SessionManager.open(file, sessionDir, cwd);
		legacy.appendCustomEntry(STASH_ENTRY_TYPE, { drafts: ["old draft"] });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const newer = SessionManager.create(cwd, sessionDir);
		appendAssistant(newer);
		await new Promise((resolve) => setTimeout(resolve, 20));

		for (let attempt = 0; attempt < 2; attempt++) {
			const opened = SessionManager.open(file);
			opened.appendModelChange("openai", "startup-model");
			opened.appendThinkingLevelChange("off");
			opened.appendCustomEntry("other-extension-startup", undefined);
			const harness = createHarness((type, data) => opened.appendCustomEntry(type, data));
			const context = createContext({
				cwd, sessionManager: opened, mode: "tui", model: { provider: "openai", id: "startup-model" },
			});
			await harness.events.get("session_start")?.({}, context.ctx);
			assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), newer.getSessionFile(), `open ${attempt + 1}`);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("an upgraded recovery keeps a native model edit when startup has no model", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-legacy-no-model-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const file = join(sessionDir, "legacy-pi-stash-recovery.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(file, "");
		const legacy = SessionManager.open(file, sessionDir, cwd);
		legacy.appendCustomEntry(STASH_ENTRY_TYPE, { drafts: ["legacy draft"] });
		legacy.appendCustomEntry("pi-stash-recovery-opened", undefined);
		await new Promise((resolve) => setTimeout(resolve, 20));
		appendAssistant(SessionManager.create(cwd, sessionDir));
		await new Promise((resolve) => setTimeout(resolve, 20));
		legacy.appendModelChange("openai", "user-selected-model");
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), file);

		const opened = SessionManager.open(file);
		opened.appendThinkingLevelChange("off");
		const harness = createHarness((type, data) => opened.appendCustomEntry(type, data));
		const context = createContext({ cwd, sessionManager: opened, mode: "tui" });
		await harness.events.get("session_start")?.({}, context.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), file);
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

test("a late recovery startup respects an original clear and later edits", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-stash-late-recovery-start-"));
	try {
		const sessionDir = join(cwd, "sessions");
		const original = SessionManager.create(cwd, sessionDir);
		const harness = createHarness((type, data) => original.appendCustomEntry(type, data));
		const context = createContext({
			cwd, sessionManager: original, mode: "tui", customResult: { action: "clear" },
		});
		await harness.commands.get("stash")?.handler("keep me", context.ctx);
		if (existsSync(original.getSessionFile()!)) {
			t.skip("this Pi host saves new sessions immediately");
			return;
		}

		const opening = SessionManager.continueRecent(cwd, sessionDir);
		await harness.commands.get("stash-list")?.handler("", context.ctx);
		const emptyRecovery = SessionManager.continueRecent(cwd, sessionDir).getSessionFile()!;
		opening.appendModelChange("openai", "test");
		opening.appendThinkingLevelChange("off");
		const future = new Date(statSync(emptyRecovery).mtimeMs + 1_000);
		utimesSync(opening.getSessionFile()!, future, future);
		const openingHarness = createHarness((type, data) => opening.appendCustomEntry(type, data));
		const openingContext = createContext({ cwd, sessionManager: opening, mode: "tui" });
		await openingHarness.events.get("session_start")?.({}, openingContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), emptyRecovery);

		appendAssistant(original);
		assert.deepEqual(hydrateState(SessionManager.open(original.getSessionFile()!).getBranch()).drafts, []);
		assert.equal(existsSync(emptyRecovery), true);
		assert.deepEqual(hydrateState(SessionManager.continueRecent(cwd, sessionDir).getBranch()).drafts, []);

		const openingFile = opening.getSessionFile()!;
		opening.appendThinkingLevelChange("high");
		await openingHarness.events.get("thinking_level_select")?.({}, openingContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), openingFile);
		await openingHarness.events.get("session_shutdown")?.({}, openingContext.ctx);

		const reopened = SessionManager.open(openingFile);
		reopened.appendModelChange("openai", "test");
		reopened.appendThinkingLevelChange("off");
		const reopenedHarness = createHarness((type, data) => reopened.appendCustomEntry(type, data));
		const reopenedContext = createContext({ cwd, sessionManager: reopened, mode: "tui" });
		await reopenedHarness.events.get("session_start")?.({}, reopenedContext.ctx);
		assert.equal(SessionManager.continueRecent(cwd, sessionDir).getSessionFile(), openingFile);
		assert.deepEqual(hydrateState(reopened.getBranch()).drafts, ["keep me"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent end does not overtake later stash edits", async (t) => {
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
	const context = createContext({ branchEntries: [] });

	await harness.commands.get("stash")?.handler("   ", context.ctx);

	assert.equal(harness.appended.length, 0);
	assert.equal(context.notifications.some((entry) => entry.message === "Nothing to stash"), true);
});
