import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

interface SaveResult {
	editorText: string;
	notifications: { message: string; type: string }[];
	error?: string;
}

function save(child: ChildProcess, cwd: string, draft: string, editor: boolean): Promise<SaveResult> {
	const result = once(child, "message").then(([message]) => message as SaveResult);
	child.send({ cwd, draft, editor });
	return result;
}

// Regression for #36. The IPC start signal is outside the unmodified storage mutation.
test("eight independent Pi windows retain every successful stash below the cap", { timeout: 30_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-stash-processes-"));
	const children = Array.from({ length: 8 }, () => fork(new URL("fixtures/stash-process.mjs", import.meta.url), [], {
		env: { ...process.env, PI_CODING_AGENT_DIR: root },
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	}));
	t.after(async () => {
		await Promise.all(children.map(async (child) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}));
		rmSync(root, { recursive: true, force: true });
	});
	assert.deepEqual(await Promise.all(children.map(async (child) => (await once(child, "message"))[0])),
		Array.from({ length: 8 }, () => ({ ready: true })));

	const lostPerRound: number[] = [];
	for (let round = 0; round < 12; round++) {
		const cwd = join(root, `project-${round}`);
		const expected = children.map((_, worker) => `round-${round}-worker-${worker}`);
		const results = await Promise.all(children.map((child, worker) => save(child, cwd, expected[worker], worker % 2 === 0)));
		assert.deepEqual(results.map((result) => result.error), Array(8).fill(undefined));
		assert.deepEqual(results.map((result) => result.editorText), Array(8).fill(""));
		assert.ok(results.every((result) => result.notifications.some((entry) => entry.type === "info" && entry.message.startsWith("Stashed "))));
		const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
		const stored = JSON.parse(readFileSync(join(root, "pi-stash", `${key}.json`), "utf8"));
		assert.equal(stored.cwd, cwd);
		lostPerRound.push(expected.filter((draft) => !stored.drafts.includes(draft)).length);
		assert.ok(stored.drafts.every((draft: string) => expected.includes(draft)));
		assert.equal(new Set(stored.drafts).size, stored.drafts.length);
	}
	t.diagnostic(JSON.stringify({ workers: 8, rounds: 12, lostPerRound }));
	assert.deepEqual(lostPerRound, Array(12).fill(0));
});
