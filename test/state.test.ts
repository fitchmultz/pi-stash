/**
 * Purpose: Verify the pure stash-state helpers used by the pi-stash extension.
 * Responsibilities: Cover hydration, stack push/pop behavior, indexed removal, selection clamping, and preview formatting.
 * Scope: Unit tests for extensions/state.ts only.
 * Usage: Run with `npm test` or `node --test test`.
 * Invariants/Assumptions: Tests avoid pi runtime dependencies and assert only stable helper behavior.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
	clampSelectedIndex,
	countLabel,
	hydrateState,
	MAX_STASHED_DRAFTS,
	popDraft,
	previewDraft,
	pushDraft,
	removeDraftAt,
	STASH_ENTRY_TYPE,
} from "../extensions/state.ts";

test("hydrateState returns the latest valid stash snapshot", () => {
	const state = hydrateState([
		{ type: "custom", customType: STASH_ENTRY_TYPE, data: { drafts: ["older"] } },
		{ type: "custom", customType: "other-extension", data: { drafts: ["ignore"] } },
		{ type: "custom", customType: STASH_ENTRY_TYPE, data: { drafts: ["newest", "older"] } },
	]);

	assert.deepEqual(state, { drafts: ["newest", "older"] });
});

test("hydrateState ignores malformed snapshots", () => {
	const state = hydrateState([
		{ type: "custom", customType: STASH_ENTRY_TYPE, data: { drafts: ["ok", 42] } },
		{ type: "message", customType: STASH_ENTRY_TYPE, data: { drafts: ["wrong type"] } },
	]);

	assert.deepEqual(state, { drafts: [] });
});

test("pushDraft keeps newest drafts first and enforces the limit", () => {
	const drafts = Array.from({ length: MAX_STASHED_DRAFTS }, (_, index) => `draft-${index}`);
	const next = pushDraft(drafts, "fresh");

	assert.equal(next.length, MAX_STASHED_DRAFTS);
	assert.equal(next[0], "fresh");
	assert.equal(next.at(-1), `draft-${MAX_STASHED_DRAFTS - 2}`);
});

test("popDraft returns the top draft and remaining stack", () => {
	const result = popDraft(["top", "older"]);

	assert.equal(result.draft, "top");
	assert.deepEqual(result.remaining, ["older"]);
});

test("removeDraftAt removes the selected draft and keeps neighboring selection stable", () => {
	const result = removeDraftAt(["latest", "middle", "oldest"], 1);

	assert.equal(result.draft, "middle");
	assert.deepEqual(result.remaining, ["latest", "oldest"]);
	assert.equal(result.nextIndex, 1);
});

test("removeDraftAt moves selection backward when deleting the last draft", () => {
	const result = removeDraftAt(["latest", "oldest"], 1);

	assert.equal(result.draft, "oldest");
	assert.deepEqual(result.remaining, ["latest"]);
	assert.equal(result.nextIndex, 0);
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
