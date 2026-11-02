import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { readDrafts } from "../extensions/state.ts";

/** pi exposes no public viewport observer or TUI-mode switch; reach the host's private members only for this test. */
interface HostInternals {
  renderer: { mode: string; previousScreen?: string[]; previousLines?: string[] };
  switchTuiMode: (mode: "fullscreen" | "regular") => boolean;
}

function hostInternals(mode: object): HostInternals {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-004: pi exposes no public viewport/TUI-mode-switch API (host ponytail); this assertion binds the host's private renderer and mode switch for this test only.
  return mode as unknown as HostInternals;
}

function currentContext(holder: { current?: ExtensionCommandContext }): ExtensionCommandContext {
  const current = holder.current;
  if (current === undefined) {
    throw new Error("qa-context must run before interacting with the command context");
  }
  return current;
}

class MemoryTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  onInput?: (data: string) => void;
  onResize?: () => void;
  start(input: (data: string) => void, resize: () => void) {
    this.onInput = input;
    this.onResize = resize;
  }
  stop() {
    delete this.onInput;
    delete this.onResize;
  }
  async drainInput() {
    /* Nothing is buffered to drain. */
  }
  write(_data: string) {
    /* The memory terminal renders nothing. */
  }
  moveBy(_lines: number) {
    /* Cursor movement is not tracked. */
  }
  hideCursor() {
    /* The cursor is not rendered. */
  }
  showCursor() {
    /* The cursor is not rendered. */
  }
  clearLine() {
    /* The memory terminal renders nothing. */
  }
  clearFromCursor() {
    /* The memory terminal renders nothing. */
  }
  clearScreen() {
    /* The memory terminal renders nothing. */
  }
  setTitle(_title: string) {
    /* Window titles are not rendered. */
  }
  setProgress(_active: boolean) {
    /* Progress reporting is not rendered. */
  }
  setProgramStatus() {
    /* Program status is not rendered. */
  }
  send(data: string) {
    assert.ok(this.onInput);
    this.onInput(data);
  }
  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }
}
const rendered = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 40);
  });

nodeTest(
  "native stash shortcuts, picker mouse and replacement preserve drafts",
  { timeout: 20_000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "pi-stash-native-"));
    const agentDir = join(home, "agent");
    mkdirSync(agentDir);
    const previous = {
      HOME: process.env.HOME,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    };
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("No network in native stash test");
    });
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const pi = await import("@earendil-works/pi-coding-agent");
      const commandContexts: { current?: ExtensionCommandContext } = {};
      const settingsManager = pi.SettingsManager.inMemory({ theme: "dark", quietStartup: true });
      const modelRuntime = await pi.ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        allowModelNetwork: false,
      });
      const runtime = await pi.createAgentSessionRuntime(
        async ({ cwd, sessionManager }) => {
          const services = await pi.createAgentSessionServices({
            cwd,
            agentDir,
            modelRuntime,
            settingsManager,
            resourceLoaderOptions: {
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              additionalExtensionPaths: [
                fileURLToPath(new URL("../extensions/stash.ts", import.meta.url)),
              ],
              extensionFactories: [
                (api) =>
                  api.registerCommand("qa-context", {
                    handler: async (_args, ctx) => {
                      commandContexts.current = ctx;
                    },
                  }),
              ],
            },
          });
          assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
          return {
            ...(await pi.createAgentSessionFromServices({ services, sessionManager, tools: [] })),
            services,
            diagnostics: services.diagnostics,
          };
        },
        { cwd: home, agentDir, sessionManager: pi.SessionManager.inMemory(home) },
      );
      const terminal = new MemoryTerminal();
      const mode = new pi.InteractiveMode(runtime, { terminal, initialThemeSetting: "dark" });
      const internals = hostInternals(mode);
      cleanup = async () => {
        try {
          mode.stop();
        } finally {
          await runtime.dispose();
        }
      };
      await mode.init();
      await runtime.session.prompt("/qa-context");
      const stashFile = join(
        agentDir,
        "pi-stash",
        `${createHash("sha256").update(home).digest("hex").slice(0, 16)}.json`,
      );
      const drafts = (): string[] => {
        const result = readDrafts(JSON.parse(readFileSync(stashFile, "utf8")));
        if (result === undefined) {
          throw new Error("stash file must persist a draft list");
        }
        return result;
      };
      const screen = () =>
        (internals.renderer.mode === "fullscreen"
          ? internals.renderer.previousScreen
          : internals.renderer.previousLines) ?? [];
      assert.equal(internals.renderer.mode, "fullscreen");

      for (const tuiMode of ["fullscreen", "regular"] as const) {
        internals.switchTuiMode(tuiMode);
        await t.test(`${tuiMode} keyboard stash, merge and picker cancel`, async () => {
          currentContext(commandContexts).ui.setEditorText("Draft 界🙂\nsecond line");
          terminal.send("\x1b[115;6u"); // Ctrl+Shift+S through the native terminal dispatcher.
          await rendered();
          assert.equal(currentContext(commandContexts).ui.getEditorText(), "");
          assert.deepEqual(drafts(), ["Draft 界🙂\nsecond line"]);
          currentContext(commandContexts).ui.setEditorText("prefix ");
          terminal.send("\x1b[114;6u");
          await rendered();
          assert.equal(
            currentContext(commandContexts).ui.getEditorText(),
            "prefix Draft 界🙂\nsecond line",
          );
          assert.deepEqual(drafts(), []);
          await runtime.session.prompt("/stash older 界🙂");
          await runtime.session.prompt("/stash newer 界🙂");
          currentContext(commandContexts).ui.setEditorText("untouched draft");
          const picker = runtime.session.prompt("/stash-list");
          await rendered();
          terminal.resize(44, 24);
          await rendered();
          assert.ok(screen().some((line) => line.includes("newer 界")));
          terminal.send("\x1b");
          await picker;
          assert.equal(currentContext(commandContexts).ui.getEditorText(), "untouched draft");
          assert.deepEqual(drafts(), ["newer 界🙂", "older 界🙂"]);
          const restore = runtime.session.prompt("/stash-list");
          await rendered();
          terminal.send("\r");
          await restore;
          assert.equal(
            currentContext(commandContexts).ui.getEditorText(),
            "untouched draftnewer 界🙂",
          );
          const remaining = runtime.session.prompt("/stash-list");
          await rendered();
          terminal.send("\r");
          await remaining;
          assert.deepEqual(drafts(), []);
          terminal.resize(100, 30);
        });
      }

      await t.test(
        "fullscreen pointer restores the clicked draft and returns keyboard focus",
        async () => {
          internals.switchTuiMode("fullscreen");
          await runtime.session.prompt("/stash older mouse draft");
          await runtime.session.prompt("/stash newer mouse draft");
          currentContext(commandContexts).ui.setEditorText("");
          const picker = runtime.session.prompt("/stash-list");
          await rendered();
          const row = screen().findIndex((line) => line.includes("older mouse draft"));
          assert.ok(row >= 0);
          terminal.send(`\x1b[<0;5;${row + 1}M`);
          terminal.send(`\x1b[<0;5;${row + 1}m`);
          await picker;
          assert.equal(currentContext(commandContexts).ui.getEditorText(), "older mouse draft");
          terminal.send("!");
          assert.equal(currentContext(commandContexts).ui.getEditorText(), "older mouse draft!");
          assert.deepEqual(drafts(), ["newer mouse draft"]);
        },
      );

      // Regression for #37. Reload disposes custom UI before session_shutdown on current hosts.
      for (const tuiMode of ["fullscreen", "regular"] as const) {
        await t.test(`${tuiMode} reload settles a picker without changing drafts`, async () => {
          internals.switchTuiMode(tuiMode);
          currentContext(commandContexts).ui.setEditorText("preserved reload draft");
          let settled = false;
          const picker = (async () => {
            await runtime.session.prompt("/stash-list");
            settled = true;
          })();
          await rendered();
          assert.ok(screen().some((line) => line.includes("Stashed Drafts")));
          const queuedStash = runtime.session.prompt("/stash must not survive reload");
          let siblingDisposed = false;
          const sibling = currentContext(commandContexts).ui.custom<null>(
            (_tui, _theme, _keys, done) => ({
              render: () => ["Sibling dialog"],
              invalidate() {
                /* Nothing to invalidate. */
              },
              dispose() {
                if (siblingDisposed) {
                  return;
                }
                siblingDisposed = true;
                queueMicrotask(() => {
                  done(null);
                });
              },
            }),
          );
          await rendered();
          assert.ok(screen().some((line) => line.includes("Sibling dialog")));
          await currentContext(commandContexts).reload();
          await runtime.session.prompt("/qa-context");
          assert.equal(
            currentContext(commandContexts).ui.getEditorText(),
            "preserved reload draft",
          );
          currentContext(commandContexts).ui.setEditorText("new session draft");
          await rendered();
          assert.equal(settled, true, "reload must settle the outgoing stash-list command");
          assert.equal(
            siblingDisposed,
            true,
            "picker completion must not skip native sibling disposal",
          );
          await Promise.all([picker, queuedStash, sibling]);
          assert.deepEqual(drafts(), ["newer mouse draft"]);
          assert.equal(currentContext(commandContexts).ui.getEditorText(), "new session draft");
        });
      }

      await t.test(
        "newSession cancels a pending picker; fork, resume and reload preserve disk drafts",
        async () => {
          const picker = runtime.session.prompt("/stash-list");
          await rendered();
          const outgoing = currentContext(commandContexts);
          assert.equal((await outgoing.newSession()).cancelled, false);
          await picker;
          await runtime.session.prompt("/qa-context");
          assert.throws(() => outgoing.ui.getEditorText(), /stale|invalid|disposed|active/i);
          assert.deepEqual(drafts(), ["newer mouse draft"]);
          await runtime.session.prompt("/stash branch marker");
          const marker = runtime.session.sessionManager.appendCustomEntry("qa-branch");
          assert.equal(
            (await currentContext(commandContexts).fork(marker, { position: "at" })).cancelled,
            false,
          );
          await runtime.session.prompt("/qa-context");
          const manager = runtime.session.sessionManager;
          const journal = join(home, "resume.jsonl");
          writeFileSync(
            journal,
            [manager.getHeader(), ...manager.getBranch()]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          );
          assert.equal(
            (await currentContext(commandContexts).switchSession(journal)).cancelled,
            false,
          );
          await runtime.session.prompt("/qa-context");
          await currentContext(commandContexts).reload();
          await runtime.session.prompt("/qa-context");
          assert.deepEqual(drafts(), ["branch marker", "newer mouse draft"]);
          const restore = runtime.session.prompt("/stash-list");
          await rendered();
          terminal.send("\r");
          await restore;
          assert.deepEqual(drafts(), ["newer mouse draft"]);
        },
      );
    } finally {
      try {
        await cleanup?.();
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
        rmSync(home, { recursive: true, force: true });
      }
    }
  },
);
