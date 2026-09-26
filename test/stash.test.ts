/**
 * Purpose: Verify project-scoped storage and RPC-safe behavior for the pi-stash extension entrypoint.
 * Responsibilities: Cover restart persistence, multi-window safety, legacy session import, explicit `/stash` text, RPC fallbacks, and cancellation on session changes.
 * Scope: Integration-style tests around `extensions/stash.ts` with mocked pi extension APIs and a temporary agent directory.
 * Usage: Run with `npm test`.
 * Invariants/Assumptions: Mocked contexts emulate the extension API surface closely enough to catch stash-state regressions without spinning up a full pi runtime.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import piStash from "../extensions/stash.ts";
import { hydrateState, STASH_ENTRY_TYPE, type PersistedEntry } from "../extensions/state.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-stash-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

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
	sessionManager: { getBranch(): PersistedEntry[] };
}

interface RegisteredCommand {
	handler(args: string, ctx: TestContext): Promise<void>;
}

interface RegisteredShortcut {
	handler(ctx: TestContext): Promise<void>;
}

type RegisteredEvent = (event: unknown, ctx: TestContext) => unknown;

function createHarness(appendEntry?: (type: string, data: unknown) => void) {
	const commands = new Map<string, RegisteredCommand>();
	const shortcuts = new Map<string, RegisteredShortcut>();
	const events = new Map<string, RegisteredEvent>();

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
		appendEntry(type: string, data: unknown) {
			appendEntry?.(type, data);
		},
	} as never);

	return { commands, shortcuts, events };
}

function createContext(options: {
	cwd?: string;
	branchEntries?: PersistedEntry[];
	editorText?: string;
	customResult?: unknown;
	custom?: TestUI["custom"];
	confirmResult?: boolean;
	confirm?: (title: string, message: string, options?: TestDialogOptions) => Promise<boolean>;
	mode?: TestContext["mode"];
}) {
	const notifications: Notification[] = [];
	const statuses: StatusUpdate[] = [];
	let editorText = options.editorText ?? "";
	const branchEntries = options.branchEntries ?? [];

	const ctx: TestContext = {
		mode: options.mode ?? "rpc",
		hasUI: true,
		cwd: options.cwd ?? `/project/${randomUUID()}`,
		ui: {
			theme: { fg: (_name, value) => value, bold: (value) => value },
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
				return options.confirm?.(title, message, dialogOptions) ?? options.confirmResult ?? true;
			},
			async custom<T>(renderer: Parameters<TestUI["custom"]>[0]) {
				return options.custom ? options.custom<T>(renderer as never) : (options.customResult as T | undefined);
			},
		},
		sessionManager: { getBranch: () => branchEntries },
	};

	return {
		ctx,
		notifications,
		statuses,
		get editorText() {
			return editorText;
		},
	};
}

function stashPath(cwd: string, root = agentDir): string {
	return join(root, "pi-stash", `${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.json`);
}

function storedDrafts(cwd: string): string[] | undefined {
	try {
		return JSON.parse(readFileSync(stashPath(cwd), "utf8")).drafts;
	} catch {
		return undefined;
	}
}

function stashSnapshot(...drafts: string[]): PersistedEntry {
	return { type: "custom", customType: STASH_ENTRY_TYPE, data: { drafts } };
}

async function seed(cwd: string, ...draftsOldestFirst: string[]): Promise<void> {
	const harness = createHarness();
	const context = createContext({ cwd });
	for (const draft of draftsOldestFirst) await harness.commands.get("stash")!.handler(draft, context.ctx);
}

test("a stash made before any message survives restarting Pi", async () => {
	const cwd = `/project/${randomUUID()}`;
	const first = createHarness();
	const firstContext = createContext({ cwd, mode: "tui", editorText: "draft I must not lose" });
	await first.events.get("session_start")!({}, firstContext.ctx);
	await first.shortcuts.get("ctrl+shift+s")!.handler(firstContext.ctx);
	assert.equal(firstContext.editorText, "");
	await first.events.get("session_shutdown")!({}, firstContext.ctx);

	const restarted = createHarness();
	const restartedContext = createContext({ cwd, mode: "tui" });
	await restarted.events.get("session_start")!({}, restartedContext.ctx);
	assert.deepEqual(restartedContext.statuses.at(-1), { key: "pi-stash", text: "📦 1 draft" });
	await restarted.shortcuts.get("ctrl+shift+r")!.handler(restartedContext.ctx);

	assert.equal(restartedContext.editorText, "draft I must not lose");
	assert.deepEqual(storedDrafts(cwd), []);
});

test("two windows in one project keep each other's stashes", async () => {
	const cwd = `/project/${randomUUID()}`;
	const left = createHarness();
	const right = createHarness();
	const opened = Promise.withResolvers<void>();
	const choice = Promise.withResolvers<unknown>();
	let pickerCalls = 0;
	const leftContext = createContext({ cwd });
	const rightContext = createContext({
		cwd,
		mode: "tui",
		custom: async <T>() => {
			if (pickerCalls++ > 0) return { action: "cancel" } as T;
			opened.resolve();
			return (await choice.promise) as T;
		},
	});
	await left.events.get("session_start")!({}, leftContext.ctx);
	await right.events.get("session_start")!({}, rightContext.ctx);

	await left.commands.get("stash")!.handler("left draft", leftContext.ctx);
	await right.commands.get("stash")!.handler("right draft", rightContext.ctx);
	assert.deepEqual(storedDrafts(cwd), ["right draft", "left draft"]);

	const list = right.commands.get("stash-list")!.handler("", rightContext.ctx);
	await opened.promise;
	await left.commands.get("stash")!.handler("newer left draft", leftContext.ctx);
	choice.resolve({ action: "delete", index: 0 });
	await list;
	assert.deepEqual(storedDrafts(cwd), ["newer left draft", "left draft"], "delete removes the picked draft, not the newer one");
});

test("stashes are scoped to the working directory", async () => {
	const project = `/project/${randomUUID()}`;
	await seed(project, "project draft");

	const harness = createHarness();
	const other = createContext({ cwd: `/project/${randomUUID()}` });
	await harness.commands.get("stash-list")!.handler("", other.ctx);

	assert.equal(other.notifications.at(-1)?.message, "No stashed drafts");
	assert.deepEqual(storedDrafts(project), ["project draft"]);
});

test("drafts from a pre-0.3.0 session are imported once", async () => {
	const cwd = `/project/${randomUUID()}`;
	await seed(cwd, "project draft");
	const branch = [stashSnapshot("newer legacy", "project draft", "older legacy")];
	const append = (type: string, data: unknown) => branch.push({ type: "custom", customType: type, data });

	const harness = createHarness(append);
	const context = createContext({ cwd, branchEntries: branch });
	await harness.events.get("session_start")!({}, context.ctx);
	assert.deepEqual(storedDrafts(cwd), ["project draft", "newer legacy", "older legacy"]);
	assert.equal(context.notifications.at(-1)?.message, "Imported 2 drafts from this session into the project stash.");
	assert.deepEqual(hydrateState(branch), []);

	await harness.shortcuts.get("ctrl+shift+r")!.handler(context.ctx);
	assert.equal(context.editorText, "project draft");
	const reopened = createHarness(append);
	await reopened.events.get("session_start")!({}, createContext({ cwd, branchEntries: branch }).ctx);
	assert.deepEqual(storedDrafts(cwd), ["newer legacy", "older legacy"], "a restored draft is not resurrected");
});

test("an unreadable or unwritable stash file keeps the editor draft and the file", async () => {
	const cwd = `/project/${randomUUID()}`;
	mkdirSync(join(agentDir, "pi-stash"), { recursive: true });
	writeFileSync(stashPath(cwd), "{ not json");
	const harness = createHarness();
	const context = createContext({ cwd, mode: "tui", editorText: "keep this draft" });

	await assert.rejects(harness.shortcuts.get("ctrl+shift+s")!.handler(context.ctx), SyntaxError);
	assert.equal(context.editorText, "keep this draft");
	assert.equal(readFileSync(stashPath(cwd), "utf8"), "{ not json");

	const blocked = mkdtempSync(join(tmpdir(), "pi-stash-blocked-"));
	writeFileSync(join(blocked, "pi-stash"), "not a directory");
	process.env.PI_CODING_AGENT_DIR = blocked;
	try {
		context.ctx.ui.setEditorText("");
		await assert.rejects(harness.commands.get("stash")!.handler("keep explicit text", context.ctx), { code: "ENOTDIR" });
		assert.equal(context.editorText, "keep explicit text");
	} finally {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		rmSync(blocked, { recursive: true, force: true });
	}
});

test("/stash preserves explicit whitespace exactly", async () => {
	const harness = createHarness();
	const context = createContext({});

	await harness.commands.get("stash")!.handler("  keep surrounding spaces  ", context.ctx);

	assert.deepEqual(storedDrafts(context.ctx.cwd), ["  keep surrounding spaces  "]);
	assert.deepEqual(context.statuses.at(-1), { key: "pi-stash", text: "📦 1 draft" });
});

test("/stash ignores whitespace-only explicit text", async () => {
	const harness = createHarness();
	const context = createContext({});

	await harness.commands.get("stash")!.handler("   ", context.ctx);

	assert.equal(storedDrafts(context.ctx.cwd), undefined);
	assert.equal(context.notifications.at(-1)?.message, "Nothing to stash");
});

test("RPC restore falls back to the latest draft when the custom picker is unavailable", async () => {
	const harness = createHarness();
	const context = createContext({});

	await harness.commands.get("stash")!.handler("older", context.ctx);
	await harness.commands.get("stash")!.handler("latest", context.ctx);
	await harness.shortcuts.get("ctrl+shift+r")!.handler(context.ctx);

	assert.equal(context.editorText, "latest");
	assert.deepEqual(storedDrafts(context.ctx.cwd), ["older"]);
	assert.ok(context.notifications.some((entry) => entry.message.includes("using the latest stash for restore")));
});

test("RPC restore does not replace editor text when the destructive confirmation is declined", async () => {
	const harness = createHarness();
	const context = createContext({ confirmResult: false, editorText: "host draft" });

	await harness.commands.get("stash")!.handler("older", context.ctx);
	await harness.commands.get("stash")!.handler("latest", context.ctx);
	await harness.shortcuts.get("ctrl+shift+r")!.handler(context.ctx);

	assert.equal(context.editorText, "host draft");
	assert.deepEqual(storedDrafts(context.ctx.cwd), ["latest", "older"]);
	assert.equal(context.notifications.at(-1)?.message, "Restore cancelled");
});

test("RPC stash-list falls back to a textual summary when the custom picker is unavailable", async () => {
	const harness = createHarness();
	const context = createContext({});

	await harness.commands.get("stash")!.handler("older", context.ctx);
	await harness.commands.get("stash")!.handler("latest", context.ctx);
	await harness.commands.get("stash-list")!.handler("", context.ctx);

	assert.deepEqual(storedDrafts(context.ctx.cwd), ["latest", "older"]);
	assert.equal(context.notifications.at(-1)?.message, "Stashed drafts (latest first):\n1. latest\n2. older");
});

test("state mutations remain serialized while a picker is pending", async () => {
	const cwd = `/project/${randomUUID()}`;
	await seed(cwd, "older", "latest");
	const harness = createHarness();
	const opened = Promise.withResolvers<void>();
	const pickerResult = Promise.withResolvers<unknown>();
	const context = createContext({
		cwd,
		mode: "tui",
		custom: async <T>() => {
			opened.resolve();
			return (await pickerResult.promise) as T;
		},
	});

	const picker = harness.commands.get("stash-list")!.handler("", context.ctx);
	await opened.promise;
	const queuedStash = harness.commands.get("stash")!.handler("queued", context.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(storedDrafts(cwd), ["latest", "older"]);

	pickerResult.resolve({ action: "cancel" });
	await Promise.all([picker, queuedStash]);
	assert.deepEqual(storedDrafts(cwd), ["queued", "latest", "older"]);
});

test("session shutdown closes a rendered picker, clears status, and invalidates queued mutations", async () => {
	initTheme();
	const cwd = `/project/${randomUUID()}`;
	await seed(cwd, "older", "latest");
	const harness = createHarness();
	const opened = Promise.withResolvers<void>();
	let pickerDoneValue: unknown;
	const context = createContext({
		cwd,
		mode: "tui",
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
				opened.resolve();
			}),
	});

	const picker = harness.commands.get("stash-list")!.handler("", context.ctx);
	await opened.promise;
	const queuedStash = harness.commands.get("stash")!.handler("must not survive shutdown", context.ctx);

	await harness.events.get("session_shutdown")!({}, context.ctx);
	await Promise.all([picker, queuedStash]);

	assert.deepEqual(pickerDoneValue, { action: "cancel" });
	assert.deepEqual(context.statuses.at(-1), { key: "pi-stash", text: undefined });
	assert.deepEqual(storedDrafts(cwd), ["latest", "older"]);
});

test("session replacement aborts a pending TUI clear confirmation without clearing", async () => {
	const cwd = `/project/${randomUUID()}`;
	await seed(cwd, "older", "latest");
	const harness = createHarness();
	const opened = Promise.withResolvers<void>();
	let confirmationSignal: AbortSignal | undefined;
	const context = createContext({
		cwd,
		mode: "tui",
		customResult: { action: "clear" },
		confirm: (_title, _message, options) => {
			confirmationSignal = options?.signal;
			opened.resolve();
			return new Promise<boolean>((resolve) => {
				confirmationSignal?.addEventListener("abort", () => resolve(true), { once: true });
			});
		},
	});

	const pendingList = harness.commands.get("stash-list")!.handler("", context.ctx);
	await opened.promise;
	assert.equal(confirmationSignal?.aborted, false);

	await harness.events.get("session_start")!({}, context.ctx);
	await pendingList;

	assert.equal(confirmationSignal?.aborted, true);
	assert.deepEqual(storedDrafts(cwd), ["latest", "older"]);
	assert.equal(context.notifications.some((entry) => entry.message === "Cleared stashed drafts"), false);
});

test("session shutdown invalidates a pending RPC restore confirmation without restoring", async () => {
	const cwd = `/project/${randomUUID()}`;
	await seed(cwd, "latest");
	const harness = createHarness();
	const opened = Promise.withResolvers<void>();
	let confirmationSignal: AbortSignal | undefined;
	const context = createContext({
		cwd,
		confirm: (_title, _message, options) => {
			confirmationSignal = options?.signal;
			opened.resolve();
			return new Promise<boolean>((resolve) => {
				confirmationSignal?.addEventListener("abort", () => resolve(true), { once: true });
			});
		},
	});

	const pendingRestore = harness.shortcuts.get("ctrl+shift+r")!.handler(context.ctx);
	await opened.promise;
	await harness.events.get("session_shutdown")!({}, context.ctx);
	await pendingRestore;

	assert.equal(confirmationSignal?.aborted, true);
	assert.equal(context.editorText, "");
	assert.deepEqual(storedDrafts(cwd), ["latest"]);
});

test("checkpoint refuses a live picker without cancelling it", async () => {
	const cwd = `/project/${randomUUID()}`;
	await seed(cwd, "saved");
	const harness = createHarness();
	const opened = Promise.withResolvers<void>();
	const result = Promise.withResolvers<unknown>();
	const context = createContext({
		cwd,
		mode: "tui",
		custom: async <T>() => {
			opened.resolve();
			return (await result.promise) as T;
		},
	});
	const checkpoint = harness.events.get("session_checkpoint")!;
	assert.deepEqual(await checkpoint({}, context.ctx), { sleepReady: true });

	const command = harness.commands.get("stash-list")!.handler("", context.ctx);
	await opened.promise;
	assert.deepEqual(await checkpoint({}, context.ctx), { sleepReady: false, reason: "Stash interaction is still live" });
	result.resolve({ action: "cancel" });
	await command;
	assert.deepEqual(await checkpoint({}, context.ctx), { sleepReady: true });
	assert.deepEqual(storedDrafts(cwd), ["saved"]);
});
