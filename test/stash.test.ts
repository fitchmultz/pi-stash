/**
 * Purpose: Verify project-scoped storage and RPC-safe behavior for the pi-stash extension entrypoint.
 * Responsibilities: Cover restart persistence, multi-window safety, legacy session import, explicit `/stash` text, RPC fallbacks, and cancellation on session changes.
 * Scope: Integration-style tests around `extensions/stash.ts` with mocked pi extension APIs and a temporary agent directory.
 * Usage: Run with `npm test`.
 * Invariants/Assumptions: Mocked contexts emulate the extension API surface closely enough to catch stash-state regressions without spinning up a full pi runtime.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest, after as nodeAfter } from "node:test";

import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piStash from "../extensions/stash.ts";
import type { DraftPickerResult } from "../extensions/picker.ts";
import {
  hydrateState,
  readDrafts,
  STASH_ENTRY_TYPE,
  type PersistedEntry,
} from "../extensions/state.ts";

type Signal = PromiseWithResolvers<void>;

const agentDir = mkdtempSync(join(tmpdir(), "pi-stash-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
nodeAfter(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

interface Notification {
  message: string;
  type: string;
}

interface StatusUpdate {
  key: string;
  text: string | undefined;
}

interface TestTheme {
  fg: (name: string, value: string) => string;
  bold: (value: string) => string;
}

interface TestDialogOptions {
  signal?: AbortSignal;
}

interface TestComponent {
  dispose: () => void;
  handleInput: (data: string) => void;
}

type PickerRenderer = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (value: DraftPickerResult) => void,
) => TestComponent;

interface TestUI {
  theme: TestTheme;
  notify: (message: string, type: string) => void;
  setStatus: (key: string, text: string | undefined) => void;
  getEditorText: () => string;
  setEditorText: (text: string) => void;
  pasteToEditor: (text: string) => void;
  confirm: (title: string, message: string, options?: TestDialogOptions) => Promise<boolean>;
  custom: (renderer: PickerRenderer) => Promise<DraftPickerResult | undefined>;
}

interface TestContext {
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  cwd: string;
  ui: TestUI;
  sessionManager: { getBranch: () => PersistedEntry[] };
}

interface RegisteredCommand {
  handler: (args: string, ctx: TestContext) => Promise<void>;
}

interface RegisteredShortcut {
  handler: (ctx: TestContext) => Promise<void>;
}

type RegisteredEvent = (event: unknown, ctx: TestContext) => unknown;

function createHarness(appendEntry?: (type: string, data: unknown) => void) {
  const commands = new Map<string, RegisteredCommand>();
  const shortcuts = new Map<string, RegisteredShortcut>();
  const events = new Map<string, RegisteredEvent>();

  const api = {
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
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-003: the harness captures registrations through a string-keyed subset of ExtensionAPI; the host interface carries forty event overloads that cannot be implemented by a partial mock, and the captured handlers are invoked against TestContext below.
  piStash(api as unknown as ExtensionAPI);

  return { commands, shortcuts, events };
}

function requiredCommand(
  harness: ReturnType<typeof createHarness>,
  name: string,
): RegisteredCommand {
  const command = harness.commands.get(name);
  assert.ok(command, `Command must be registered: ${name}`);
  return command;
}

function requiredShortcut(
  harness: ReturnType<typeof createHarness>,
  name: string,
): RegisteredShortcut {
  const shortcut = harness.shortcuts.get(name);
  assert.ok(shortcut, `Shortcut must be registered: ${name}`);
  return shortcut;
}

function requiredEvent(harness: ReturnType<typeof createHarness>, name: string): RegisteredEvent {
  const event = harness.events.get(name);
  assert.ok(event, `Event handler must be registered: ${name}`);
  return event;
}

function createContext(options: {
  cwd?: string;
  branchEntries?: PersistedEntry[];
  editorText?: string;
  customResult?: DraftPickerResult;
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
      async custom(renderer) {
        return options.custom ? options.custom(renderer) : options.customResult;
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
  return join(
    root,
    "pi-stash",
    `${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.json`,
  );
}

function storedDrafts(cwd: string): string[] | undefined {
  try {
    return readDrafts(JSON.parse(readFileSync(stashPath(cwd), "utf8")));
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
  for (const draft of draftsOldestFirst) {
    await requiredCommand(harness, "stash").handler(draft, context.ctx);
  }
}

nodeTest("a stash made before any message survives restarting Pi", async () => {
  const cwd = `/project/${randomUUID()}`;
  const first = createHarness();
  const firstContext = createContext({ cwd, mode: "tui", editorText: "draft I must not lose" });
  await requiredEvent(first, "session_start")({}, firstContext.ctx);
  await requiredShortcut(first, "ctrl+shift+s").handler(firstContext.ctx);
  assert.equal(firstContext.editorText, "");
  await requiredEvent(first, "session_shutdown")({}, firstContext.ctx);

  const restarted = createHarness();
  const restartedContext = createContext({ cwd, mode: "tui" });
  await requiredEvent(restarted, "session_start")({}, restartedContext.ctx);
  assert.deepEqual(restartedContext.statuses.at(-1), { key: "pi-stash", text: "📦 1 draft" });
  await requiredShortcut(restarted, "ctrl+shift+r").handler(restartedContext.ctx);

  assert.equal(restartedContext.editorText, "draft I must not lose");
  assert.deepEqual(storedDrafts(cwd), []);
});

nodeTest("two windows in one project keep each other's stashes", async () => {
  const cwd = `/project/${randomUUID()}`;
  const left = createHarness();
  const right = createHarness();
  const opened: Signal = Promise.withResolvers();
  const choice = Promise.withResolvers<DraftPickerResult>();
  let pickerCalls = 0;
  const leftContext = createContext({ cwd });
  const rightContext = createContext({
    cwd,
    mode: "tui",
    custom: async () => {
      if (pickerCalls++ > 0) {
        return { action: "cancel" };
      }
      opened.resolve();
      return await choice.promise;
    },
  });
  await requiredEvent(left, "session_start")({}, leftContext.ctx);
  await requiredEvent(right, "session_start")({}, rightContext.ctx);

  await requiredCommand(left, "stash").handler("left draft", leftContext.ctx);
  await requiredCommand(right, "stash").handler("right draft", rightContext.ctx);
  assert.deepEqual(storedDrafts(cwd), ["right draft", "left draft"]);

  const list = requiredCommand(right, "stash-list").handler("", rightContext.ctx);
  await opened.promise;
  await requiredCommand(left, "stash").handler("newer left draft", leftContext.ctx);
  choice.resolve({ action: "delete", index: 0 });
  await list;
  assert.deepEqual(
    storedDrafts(cwd),
    ["newer left draft", "left draft"],
    "delete removes the picked draft, not the newer one",
  );
});

nodeTest("stashes are scoped to the working directory", async () => {
  const project = `/project/${randomUUID()}`;
  await seed(project, "project draft");

  const harness = createHarness();
  const other = createContext({ cwd: `/project/${randomUUID()}` });
  await requiredCommand(harness, "stash-list").handler("", other.ctx);

  assert.equal(other.notifications.at(-1)?.message, "No stashed drafts");
  assert.deepEqual(storedDrafts(project), ["project draft"]);
});

nodeTest("drafts from a pre-0.3.0 session are imported once", async () => {
  const cwd = `/project/${randomUUID()}`;
  await seed(cwd, "project draft");
  const branch = [stashSnapshot("newer legacy", "project draft", "older legacy")];
  const append = (type: string, data: unknown) => {
    branch.push({ type: "custom", customType: type, data });
  };

  const harness = createHarness(append);
  const context = createContext({ cwd, branchEntries: branch });
  await requiredEvent(harness, "session_start")({}, context.ctx);
  assert.deepEqual(storedDrafts(cwd), ["project draft", "newer legacy", "older legacy"]);
  assert.equal(
    context.notifications.at(-1)?.message,
    "Imported 2 drafts from this session into the project stash.",
  );
  assert.deepEqual(hydrateState(branch), []);

  await requiredShortcut(harness, "ctrl+shift+r").handler(context.ctx);
  assert.equal(context.editorText, "project draft");
  const reopened = createHarness(append);
  await requiredEvent(reopened, "session_start")(
    {},
    createContext({ cwd, branchEntries: branch }).ctx,
  );
  assert.deepEqual(
    storedDrafts(cwd),
    ["newer legacy", "older legacy"],
    "a restored draft is not resurrected",
  );
});

nodeTest("an unreadable or unwritable stash file keeps the editor draft and the file", async () => {
  const cwd = `/project/${randomUUID()}`;
  mkdirSync(join(agentDir, "pi-stash"), { recursive: true });
  writeFileSync(stashPath(cwd), "{ not json");
  const harness = createHarness();
  const context = createContext({ cwd, mode: "tui", editorText: "keep this draft" });

  await assert.rejects(requiredShortcut(harness, "ctrl+shift+s").handler(context.ctx), SyntaxError);
  assert.equal(context.editorText, "keep this draft");
  assert.equal(readFileSync(stashPath(cwd), "utf8"), "{ not json");

  const blocked = mkdtempSync(join(tmpdir(), "pi-stash-blocked-"));
  writeFileSync(join(blocked, "pi-stash"), "not a directory");
  process.env.PI_CODING_AGENT_DIR = blocked;
  try {
    context.ctx.ui.setEditorText("");
    await assert.rejects(
      requiredCommand(harness, "stash").handler("keep explicit text", context.ctx),
      { code: "EEXIST" },
    );
    assert.equal(context.editorText, "keep explicit text");
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    rmSync(blocked, { recursive: true, force: true });
  }
});

nodeTest(
  "a held lock is never stolen, and failed saves preserve editor and stored drafts",
  async () => {
    const cwd = `/project/${randomUUID()}`;
    await seed(cwd, "already saved");
    const lock = `${stashPath(cwd)}.lock`;
    mkdirSync(lock);
    utimesSync(lock, new Date(0), new Date(0));
    const harness = createHarness();
    const context = createContext({ cwd, mode: "tui", editorText: "keep editor draft" });
    try {
      await assert.rejects(requiredShortcut(harness, "ctrl+shift+s").handler(context.ctx), {
        code: "EEXIST",
      });
      assert.equal(context.editorText, "keep editor draft");
      assert.deepEqual(storedDrafts(cwd), ["already saved"]);
      assert.equal(existsSync(lock), true);
      assert.deepEqual(context.notifications, []);
      assert.deepEqual(context.statuses, []);

      context.ctx.ui.setEditorText("");
      await assert.rejects(
        requiredCommand(harness, "stash").handler("keep explicit draft", context.ctx),
        { code: "EEXIST" },
      );
      assert.equal(context.editorText, "keep explicit draft");
      assert.deepEqual(storedDrafts(cwd), ["already saved"]);
      assert.deepEqual(context.notifications, []);
    } finally {
      rmdirSync(lock);
    }
    await requiredShortcut(harness, "ctrl+shift+s").handler(context.ctx);
    assert.equal(context.editorText, "");
    assert.deepEqual(storedDrafts(cwd), ["keep explicit draft", "already saved"]);
  },
);

nodeTest("a busy restore lock leaves both TUI and confirmed RPC editors unchanged", async (t) => {
  for (const options of [
    { mode: "tui" as const, editorText: "" },
    { mode: "tui" as const, editorText: "original editor" },
    { mode: "rpc" as const, editorText: "rpc original" },
  ]) {
    await t.test(
      `${options.mode} with ${options.editorText !== "" ? "existing" : "empty"} text`,
      async () => {
        const cwd = `/project/${randomUUID()}`;
        await seed(cwd, "kept in stash");
        const lock = `${stashPath(cwd)}.lock`;
        mkdirSync(lock);
        const harness = createHarness();
        const context = createContext({ cwd, ...options });
        try {
          await assert.rejects(requiredShortcut(harness, "ctrl+shift+r").handler(context.ctx), {
            code: "EEXIST",
          });
          assert.equal(context.editorText, options.editorText);
          assert.deepEqual(storedDrafts(cwd), ["kept in stash"]);
          assert.deepEqual(context.notifications, []);
        } finally {
          rmdirSync(lock);
        }
      },
    );
  }
});

nodeTest(
  "an editor write failure does not remove the stored draft and releases the lock",
  async () => {
    for (const options of [
      { mode: "tui" as const, editorText: "" },
      { mode: "tui" as const, editorText: "original editor" },
      { mode: "rpc" as const, editorText: "rpc original" },
    ]) {
      const cwd = `/project/${randomUUID()}`;
      await seed(cwd, "keep stored draft");
      const harness = createHarness();
      const context = createContext({ cwd, ...options });
      const error = new Error("Editor unavailable");
      context.ctx.ui.setEditorText = () => {
        throw error;
      };
      context.ctx.ui.pasteToEditor = () => {
        throw error;
      };
      await assert.rejects(requiredShortcut(harness, "ctrl+shift+r").handler(context.ctx), error);
      assert.equal(context.editorText, options.editorText);
      assert.deepEqual(storedDrafts(cwd), ["keep stored draft"]);
      assert.equal(existsSync(`${stashPath(cwd)}.lock`), false);
      assert.deepEqual(context.notifications, []);
    }
  },
);

nodeTest(
  "a failed read releases the lock without reporting success or clearing the editor",
  async () => {
    const cwd = `/project/${randomUUID()}`;
    mkdirSync(stashPath(cwd));
    const harness = createHarness();
    const context = createContext({ cwd, mode: "tui", editorText: "keep this draft" });
    await assert.rejects(requiredShortcut(harness, "ctrl+shift+s").handler(context.ctx), {
      code: "EISDIR",
    });
    assert.equal(context.editorText, "keep this draft");
    assert.deepEqual(context.notifications, []);
    assert.equal(existsSync(`${stashPath(cwd)}.lock`), false);
    rmdirSync(stashPath(cwd));
    await requiredShortcut(harness, "ctrl+shift+s").handler(context.ctx);
    assert.equal(context.editorText, "");
    assert.deepEqual(storedDrafts(cwd), ["keep this draft"]);
  },
);

nodeTest("/stash preserves explicit whitespace exactly", async () => {
  const harness = createHarness();
  const context = createContext({});

  await requiredCommand(harness, "stash").handler("  keep surrounding spaces  ", context.ctx);

  assert.deepEqual(storedDrafts(context.ctx.cwd), ["  keep surrounding spaces  "]);
  assert.deepEqual(context.statuses.at(-1), { key: "pi-stash", text: "📦 1 draft" });
});

nodeTest("/stash ignores whitespace-only explicit text", async () => {
  const harness = createHarness();
  const context = createContext({});

  await requiredCommand(harness, "stash").handler("   ", context.ctx);

  assert.equal(storedDrafts(context.ctx.cwd), undefined);
  assert.equal(context.notifications.at(-1)?.message, "Nothing to stash");
});

nodeTest(
  "RPC restore falls back to the latest draft when the custom picker is unavailable",
  async () => {
    const harness = createHarness();
    const context = createContext({});

    await requiredCommand(harness, "stash").handler("older", context.ctx);
    await requiredCommand(harness, "stash").handler("latest", context.ctx);
    await requiredShortcut(harness, "ctrl+shift+r").handler(context.ctx);

    assert.equal(context.editorText, "latest");
    assert.deepEqual(storedDrafts(context.ctx.cwd), ["older"]);
    assert.ok(
      context.notifications.some((entry) =>
        entry.message.includes("using the latest stash for restore"),
      ),
    );
  },
);

nodeTest(
  "RPC restore does not replace editor text when the destructive confirmation is declined",
  async () => {
    const harness = createHarness();
    const context = createContext({ confirmResult: false, editorText: "host draft" });

    await requiredCommand(harness, "stash").handler("older", context.ctx);
    await requiredCommand(harness, "stash").handler("latest", context.ctx);
    await requiredShortcut(harness, "ctrl+shift+r").handler(context.ctx);

    assert.equal(context.editorText, "host draft");
    assert.deepEqual(storedDrafts(context.ctx.cwd), ["latest", "older"]);
    assert.equal(context.notifications.at(-1)?.message, "Restore cancelled");
  },
);

nodeTest(
  "RPC stash-list falls back to a textual summary when the custom picker is unavailable",
  async () => {
    const harness = createHarness();
    const context = createContext({});

    await requiredCommand(harness, "stash").handler("older", context.ctx);
    await requiredCommand(harness, "stash").handler("latest", context.ctx);
    await requiredCommand(harness, "stash-list").handler("", context.ctx);

    assert.deepEqual(storedDrafts(context.ctx.cwd), ["latest", "older"]);
    assert.equal(
      context.notifications.at(-1)?.message,
      "Stashed drafts (latest first):\n1. latest\n2. older",
    );
  },
);

nodeTest("state mutations remain serialized while a picker is pending", async () => {
  const cwd = `/project/${randomUUID()}`;
  await seed(cwd, "older", "latest");
  const harness = createHarness();
  const opened: Signal = Promise.withResolvers();
  const pickerResult = Promise.withResolvers<DraftPickerResult>();
  const context = createContext({
    cwd,
    mode: "tui",
    custom: async () => {
      opened.resolve();
      return await pickerResult.promise;
    },
  });

  const picker = requiredCommand(harness, "stash-list").handler("", context.ctx);
  await opened.promise;
  const queuedStash = requiredCommand(harness, "stash").handler("queued", context.ctx);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.deepEqual(storedDrafts(cwd), ["latest", "older"]);

  pickerResult.resolve({ action: "cancel" });
  await Promise.all([picker, queuedStash]);
  assert.deepEqual(storedDrafts(cwd), ["queued", "latest", "older"]);
});

nodeTest("disposed pickers cancel once and invalidate queued work despite stale keys", async () => {
  initTheme();
  const cwd = `/project/${randomUUID()}`;
  await seed(cwd, "older", "latest");
  const harness = createHarness();
  const opened: Signal = Promise.withResolvers();
  const completions: DraftPickerResult[] = [];
  let component: TestComponent | undefined;
  const context = createContext({
    cwd,
    mode: "tui",
    editorText: "keep editor draft",
    custom: (renderer) =>
      new Promise<DraftPickerResult | undefined>((resolve) => {
        component = renderer(
          {
            requestRender() {
              /* No rendering needed in tests. */
            },
          },
          { fg: (_name: string, value: string) => value, bold: (value: string) => value },
          {},
          (value) => {
            completions.push(value);
            component?.dispose();
            resolve(value);
          },
        );
        opened.resolve();
      }),
  });
  const picker = requiredCommand(harness, "stash-list").handler("", context.ctx);
  await opened.promise;
  const queuedStash = requiredCommand(harness, "stash").handler(
    "must not survive shutdown",
    context.ctx,
  );
  assert.ok(component, "picker factory must produce its component");
  component.dispose();
  component.dispose();
  for (const key of ["\r", "\x04", "\x18", "\x1b"]) {
    component.handleInput(key);
  }
  await Promise.all([picker, queuedStash]);
  assert.deepEqual(completions, [{ action: "cancel" }]);
  assert.deepEqual(storedDrafts(cwd), ["latest", "older"]);
  assert.equal(context.editorText, "keep editor draft");
  await requiredCommand(harness, "stash").handler("fresh after disposal", context.ctx);
  assert.deepEqual(storedDrafts(cwd), ["fresh after disposal", "latest", "older"]);
  await requiredEvent(harness, "session_shutdown")({}, context.ctx);
  assert.deepEqual(completions, [{ action: "cancel" }]);
});

nodeTest(
  "session shutdown closes a rendered picker, clears status, and invalidates queued mutations",
  async () => {
    initTheme();
    const cwd = `/project/${randomUUID()}`;
    await seed(cwd, "older", "latest");
    const harness = createHarness();
    const opened: Signal = Promise.withResolvers();
    let pickerDoneValue: DraftPickerResult | undefined;
    const context = createContext({
      cwd,
      mode: "tui",
      custom: (renderer) =>
        new Promise<DraftPickerResult | undefined>((resolve) => {
          renderer(
            {
              requestRender() {
                /* No rendering needed in tests. */
              },
            },
            { fg: (_name: string, value: string) => value, bold: (value: string) => value },
            {},
            (value) => {
              pickerDoneValue = value;
              resolve(value);
            },
          );
          opened.resolve();
        }),
    });

    const picker = requiredCommand(harness, "stash-list").handler("", context.ctx);
    await opened.promise;
    const queuedStash = requiredCommand(harness, "stash").handler(
      "must not survive shutdown",
      context.ctx,
    );

    await requiredEvent(harness, "session_shutdown")({}, context.ctx);
    await Promise.all([picker, queuedStash]);

    assert.deepEqual(pickerDoneValue, { action: "cancel" });
    assert.deepEqual(context.statuses.at(-1), { key: "pi-stash", text: undefined });
    assert.deepEqual(storedDrafts(cwd), ["latest", "older"]);
  },
);

nodeTest(
  "session replacement and tree navigation abort a pending TUI clear confirmation without clearing",
  async () => {
    for (const event of ["session_start", "session_tree"]) {
      const cwd = `/project/${randomUUID()}`;
      await seed(cwd, "older", "latest");
      const harness = createHarness();
      const opened: Signal = Promise.withResolvers();
      let confirmationSignal: AbortSignal | undefined;
      const context = createContext({
        cwd,
        mode: "tui",
        customResult: { action: "clear" },
        confirm: (_title, _message, options) => {
          confirmationSignal = options?.signal;
          opened.resolve();
          return new Promise<boolean>((resolve) => {
            confirmationSignal?.addEventListener(
              "abort",
              () => {
                resolve(true);
              },
              { once: true },
            );
          });
        },
      });

      const pendingList = requiredCommand(harness, "stash-list").handler("", context.ctx);
      await opened.promise;
      assert.equal(confirmationSignal?.aborted, false);

      await requiredEvent(harness, event)({}, context.ctx);
      await pendingList;

      assert.equal(confirmationSignal.aborted, true);
      assert.deepEqual(storedDrafts(cwd), ["latest", "older"]);
      assert.equal(
        context.notifications.some((entry) => entry.message === "Cleared stashed drafts"),
        false,
      );
    }
  },
);

nodeTest("a picker resolved immediately before shutdown cannot use the stale editor", async () => {
  const cwd = `/project/${randomUUID()}`;
  await seed(cwd, "saved");
  const harness = createHarness();
  const opened: Signal = Promise.withResolvers();
  const choice = Promise.withResolvers<DraftPickerResult>();
  const context = createContext({
    cwd,
    mode: "tui",
    custom: async () => {
      opened.resolve();
      return await choice.promise;
    },
  });
  const picker = requiredCommand(harness, "stash-list").handler("", context.ctx);
  await opened.promise;
  choice.resolve({ action: "restore", index: 0 });
  const shutdown = requiredEvent(harness, "session_shutdown")({}, context.ctx);
  Object.defineProperty(context.ctx, "ui", {
    get() {
      throw new Error("stale editor");
    },
  });
  await shutdown;
  await picker;
  assert.deepEqual(storedDrafts(cwd), ["saved"]);
  assert.equal(context.editorText, "");
});

nodeTest(
  "session shutdown invalidates a pending RPC restore confirmation without restoring",
  async () => {
    const cwd = `/project/${randomUUID()}`;
    await seed(cwd, "latest");
    const harness = createHarness();
    const opened: Signal = Promise.withResolvers();
    let confirmationSignal: AbortSignal | undefined;
    const context = createContext({
      cwd,
      confirm: (_title, _message, options) => {
        confirmationSignal = options?.signal;
        opened.resolve();
        return new Promise<boolean>((resolve) => {
          confirmationSignal?.addEventListener(
            "abort",
            () => {
              resolve(true);
            },
            { once: true },
          );
        });
      },
    });

    const pendingRestore = requiredShortcut(harness, "ctrl+shift+r").handler(context.ctx);
    await opened.promise;
    await requiredEvent(harness, "session_shutdown")({}, context.ctx);
    await pendingRestore;

    assert.equal(confirmationSignal?.aborted, true);
    assert.equal(context.editorText, "");
    assert.deepEqual(storedDrafts(cwd), ["latest"]);
  },
);
