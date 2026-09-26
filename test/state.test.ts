/**
 * Purpose: Verify the pure stash-state helpers used by the pi-stash extension.
 * Responsibilities: Cover hydration, stack push behavior, draft removal, selection clamping, and preview formatting.
 * Scope: Unit tests for extensions/state.ts only.
 * Usage: Run with `npm test`.
 * Invariants/Assumptions: Tests avoid pi runtime dependencies and assert only stable helper behavior.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	clampSelectedIndex,
	countLabel,
	hydrateState,
	MAX_STASHED_DRAFTS,
	previewDraft,
	pushDraft,
	STASH_ENTRY_TYPE,
	withoutDraft,
} from "../extensions/state.ts";

test("hydrateState returns the latest valid stash snapshot", () => {
	const state = hydrateState([
		{ type: "custom", customType: STASH_ENTRY_TYPE, data: { drafts: ["older"] } },
		{ type: "custom", customType: "other-extension", data: { drafts: ["ignore"] } },
		{ type: "custom", customType: STASH_ENTRY_TYPE, data: { drafts: ["newest", "older"] } },
	]);

	assert.deepEqual(state, ["newest", "older"]);
});

test("hydrateState ignores malformed snapshots", () => {
	const state = hydrateState([
		{ type: "custom", customType: STASH_ENTRY_TYPE, data: { drafts: ["ok", 42] } },
		{ type: "message", customType: STASH_ENTRY_TYPE, data: { drafts: ["wrong type"] } },
	]);

	assert.deepEqual(state, []);
});

test("pushDraft keeps newest drafts first and enforces the limit", () => {
	const drafts = Array.from({ length: MAX_STASHED_DRAFTS }, (_, index) => `draft-${index}`);
	const next = pushDraft(drafts, "fresh");

	assert.equal(next.length, MAX_STASHED_DRAFTS);
	assert.equal(next[0], "fresh");
	assert.equal(next.at(-1), `draft-${MAX_STASHED_DRAFTS - 2}`);
});

test("withoutDraft removes only the newest matching draft", () => {
	assert.deepEqual(withoutDraft(["same", "other", "same"], "same"), ["other", "same"]);
	assert.deepEqual(withoutDraft(["other"], "missing"), ["other"]);
});

test("clampSelectedIndex keeps picker selection in bounds", () => {
	assert.equal(clampSelectedIndex(-1, 3), 0);
	assert.equal(clampSelectedIndex(99, 3), 2);
	assert.equal(clampSelectedIndex(5, 0), 0);
});

test("previewDraft flattens whitespace and truncates long drafts", () => {
	assert.equal(previewDraft("hello\n\nworld"), "hello world");
	assert.equal(previewDraft("abcdefghij", 6), "abcde…");
});

test("countLabel pluralizes draft counts", () => {
	assert.equal(countLabel(1), "1 draft");
	assert.equal(countLabel(2), "2 drafts");
});
