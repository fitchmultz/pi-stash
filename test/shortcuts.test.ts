/**
 * Purpose: Verify configurable stash/restore shortcuts for the pi-stash extension.
 * Responsibilities: Cover default shortcuts, custom overrides, disabling via false, and invalid config handling.
 * Scope: Unit tests for resolveShortcuts in extensions/stash.ts only.
 * Usage: Run with `npm test`.
 * Invariants/Assumptions: Tests pass explicit agent dirs so PI_CODING_AGENT_DIR is never touched.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { DEFAULT_SHORTCUTS, resolveShortcuts } from "../extensions/stash.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stash-shortcuts-"));
	roots.push(dir);
	return dir;
}

test("resolveShortcuts returns defaults when the config file is missing", () => {
	assert.deepEqual(resolveShortcuts(freshDir()), {
		stash: DEFAULT_SHORTCUTS.stash,
		restore: DEFAULT_SHORTCUTS.restore,
	});
});

test("resolveShortcuts honors custom shortcut strings", () => {
	const dir = freshDir();
	writeFileSync(join(dir, "pi-stash.json"), JSON.stringify({ shortcuts: { stash: "ctrl+s", restore: "ctrl+r" } }));
	assert.deepEqual(resolveShortcuts(dir), { stash: "ctrl+s", restore: "ctrl+r" });
});

test("resolveShortcuts supports false to disable a shortcut", () => {
	const dir = freshDir();
	writeFileSync(join(dir, "pi-stash.json"), JSON.stringify({ shortcuts: { stash: false } }));
	assert.deepEqual(resolveShortcuts(dir), { stash: false, restore: DEFAULT_SHORTCUTS.restore });
});

test("resolveShortcuts rejects invalid config", () => {
	const badJson = freshDir();
	writeFileSync(join(badJson, "pi-stash.json"), "{not json");
	assert.throws(() => resolveShortcuts(badJson), /Failed to parse/);

	const badShape = freshDir();
	writeFileSync(join(badShape, "pi-stash.json"), JSON.stringify({ shortcuts: { stash: 42 } }));
	assert.throws(() => resolveShortcuts(badShape), /Invalid shortcuts\.stash/);
});
