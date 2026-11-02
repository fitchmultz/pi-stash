import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { isRecord } from "../extensions/state.ts";

interface Notification {
  message: string;
  type: string;
}

interface SaveResult {
  editorText: string;
  notifications: Notification[];
  error?: string;
}

interface StoredStash {
  cwd: string;
  drafts: string[];
}

function isSaveResult(value: unknown): value is SaveResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("editorText" in value) || !("notifications" in value)) {
    return false;
  }
  const { editorText, notifications } = value;
  if (typeof editorText !== "string" || !Array.isArray(notifications)) {
    return false;
  }
  return notifications.every(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      "message" in item &&
      typeof item.message === "string" &&
      "type" in item &&
      typeof item.type === "string",
  );
}

function isStoredStash(value: unknown): value is StoredStash {
  return (
    typeof value === "object" &&
    value !== null &&
    "cwd" in value &&
    typeof value.cwd === "string" &&
    "drafts" in value &&
    Array.isArray(value.drafts) &&
    value.drafts.every((draft) => typeof draft === "string")
  );
}

function save(
  child: ChildProcess,
  cwd: string,
  draft: string,
  editor: boolean,
): Promise<SaveResult> {
  const result = once(child, "message").then((messages) => {
    /** Narrow the IPC reply before trusting its shape. */
    const message: unknown = messages[0];
    if (!isSaveResult(message)) {
      throw new Error("fixture child must reply with a SaveResult");
    }
    return message;
  });
  child.send({ cwd, draft, editor });
  return result;
}

// Regression for #36. The IPC start signal is outside the unmodified storage mutation.
nodeTest(
  "eight independent Pi windows retain every successful stash below the cap",
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-stash-processes-"));
    const children = Array.from({ length: 8 }, () =>
      fork(new URL("fixtures/stash-process.ts", import.meta.url), [], {
        env: { ...process.env, PI_CODING_AGENT_DIR: root },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      }),
    );
    t.after(async () => {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return;
          }
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }),
      );
      rmSync(root, { recursive: true, force: true });
    });
    assert.deepEqual(
      await Promise.all(
        children.map(async (child) => {
          const messages: unknown[] = await once(child, "message");
          const message = messages[0];
          if (!isRecord(message)) {
            assert.fail("fixture child must announce readiness with an object");
          }
          return message;
        }),
      ),
      Array.from({ length: 8 }, () => ({ ready: true })),
    );

    const lostPerRound: number[] = [];
    for (let round = 0; round < 12; round++) {
      const cwd = join(root, `project-${round}`);
      const expected = children.map((_, worker) => `round-${round}-worker-${worker}`);
      const results = await Promise.all(
        children.map(async (child, worker) => {
          const draft = expected[worker];
          assert.ok(draft !== undefined, "each worker must have an expected draft");
          return await save(child, cwd, draft, worker % 2 === 0);
        }),
      );
      assert.ok(results.every((result) => result.error === undefined));
      assert.deepEqual(
        results.map((result) => result.editorText),
        Array.from({ length: 8 }, () => ""),
      );
      assert.ok(
        results.every((result) =>
          result.notifications.some(
            (entry) => entry.type === "info" && entry.message.startsWith("Stashed "),
          ),
        ),
      );
      const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
      const stored: unknown = JSON.parse(
        readFileSync(join(root, "pi-stash", `${key}.json`), "utf8"),
      );
      assert.ok(isStoredStash(stored), "persisted stash must be a cwd plus string draft list");
      assert.equal(stored.cwd, cwd);
      lostPerRound.push(expected.filter((draft) => !stored.drafts.includes(draft)).length);
      assert.ok(stored.drafts.every((draft) => expected.includes(draft)));
      assert.equal(new Set(stored.drafts).size, stored.drafts.length);
    }
    t.diagnostic(JSON.stringify({ workers: 8, rounds: 12, lostPerRound }));
    assert.deepEqual(
      lostPerRound,
      Array.from({ length: 12 }, () => 0),
    );
  },
);
