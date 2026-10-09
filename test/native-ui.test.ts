import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";

class MemoryTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  onInput?: (data: string) => void;
  onResize?: () => void;
  start(input: (data: string) => void, resize: () => void) { this.onInput = input; this.onResize = resize; }
  stop() { this.onInput = undefined; this.onResize = undefined; }
  async drainInput() {}
  write(_data: string) {}
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
  setProgramStatus() {}
  send(data: string) { assert.ok(this.onInput); this.onInput(data); }
  resize(columns: number, rows: number) { this.columns = columns; this.rows = rows; this.onResize?.(); }
}
const rendered = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

test("native stash shortcuts, picker mouse and replacement preserve drafts", { timeout: 20_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-stash-native-"));
  const agentDir = join(home, "agent");
  mkdirSync(agentDir);
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network in native stash test"); });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const pi = await import("@earendil-works/pi-coding-agent");
    let context: ExtensionCommandContext | undefined;
    const settingsManager = pi.SettingsManager.inMemory({ theme: "dark", quietStartup: true });
    const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const runtime = await pi.createAgentSessionRuntime(async ({ cwd, sessionManager }) => {
      const services = await pi.createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager,
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: [fileURLToPath(new URL("../extensions/stash.ts", import.meta.url))],
          extensionFactories: [(api) => api.registerCommand("qa-context", { handler: async (_args, ctx) => { context = ctx; } })],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      return { ...await pi.createAgentSessionFromServices({ services, sessionManager, tools: [] }), services, diagnostics: services.diagnostics };
    }, { cwd: home, agentDir, sessionManager: pi.SessionManager.inMemory(home) });
    const terminal = new MemoryTerminal();
    const mode = new pi.InteractiveMode(runtime, { terminal, initialThemeSetting: "dark" });
    cleanup = async () => { try { mode.stop(); } finally { await runtime.dispose(); } };
    await mode.init();
    await runtime.session.prompt("/qa-context");
    const stashFile = join(agentDir, "pi-stash", `${createHash("sha256").update(home).digest("hex").slice(0, 16)}.json`);
    const drafts = () => JSON.parse(readFileSync(stashFile, "utf8")).drafts;
    // ponytail: the host has no public viewport observer; use its renderer only in this fixture until one exists.
    const renderer = () => (mode as unknown as { renderer: { mode: string; previousScreen?: string[]; previousLines?: string[] } }).renderer;
    const screen = () => (renderer().mode === "fullscreen" ? renderer().previousScreen : renderer().previousLines) ?? [];
    assert.equal(renderer().mode, "fullscreen");

    for (const tuiMode of ["fullscreen", "regular"] as const) {
      (mode as unknown as { switchTuiMode(mode: string): boolean }).switchTuiMode(tuiMode);
      await t.test(`${tuiMode} keyboard stash, merge and picker cancel`, async () => {
        context!.ui.setEditorText("Draft 界🙂\nsecond line");
        terminal.send("\x1b[115;6u"); // Ctrl+Shift+S through the native terminal dispatcher.
        await rendered();
        assert.equal(context!.ui.getEditorText(), "");
        assert.deepEqual(drafts(), ["Draft 界🙂\nsecond line"]);
        context!.ui.setEditorText("prefix ");
        terminal.send("\x1b[114;6u");
        await rendered();
        assert.equal(context!.ui.getEditorText(), "prefix Draft 界🙂\nsecond line");
        assert.deepEqual(drafts(), []);
        await runtime.session.prompt("/stash older 界🙂");
        await runtime.session.prompt("/stash newer 界🙂");
        context!.ui.setEditorText("untouched draft");
        const picker = runtime.session.prompt("/stash-list");
        await rendered();
        terminal.resize(44, 24);
        await rendered();
        assert.ok(screen().some((line) => line.includes("newer 界")));
        terminal.send("\x1b");
        await picker;
        assert.equal(context!.ui.getEditorText(), "untouched draft");
        assert.deepEqual(drafts(), ["newer 界🙂", "older 界🙂"]);
        const restore = runtime.session.prompt("/stash-list");
        await rendered();
        terminal.send("\r");
        await restore;
        assert.equal(context!.ui.getEditorText(), "untouched draftnewer 界🙂");
        const remaining = runtime.session.prompt("/stash-list");
        await rendered();
        terminal.send("\r");
        await remaining;
        assert.deepEqual(drafts(), []);
        terminal.resize(100, 30);
      });
    }

    await t.test("fullscreen pointer restores the clicked draft and returns keyboard focus", async () => {
      (mode as unknown as { switchTuiMode(mode: string): boolean }).switchTuiMode("fullscreen");
      await runtime.session.prompt("/stash older mouse draft");
      await runtime.session.prompt("/stash newer mouse draft");
      context!.ui.setEditorText("");
      const picker = runtime.session.prompt("/stash-list");
      await rendered();
      const row = screen().findIndex((line) => line.includes("older mouse draft"));
      assert.ok(row >= 0);
      terminal.send(`\x1b[<0;5;${row + 1}M`);
      terminal.send(`\x1b[<0;5;${row + 1}m`);
      await picker;
      assert.equal(context!.ui.getEditorText(), "older mouse draft");
      terminal.send("!");
      assert.equal(context!.ui.getEditorText(), "older mouse draft!");
      assert.deepEqual(drafts(), ["newer mouse draft"]);
    });

    await t.test("newSession cancels a pending picker; fork, resume and reload preserve disk drafts", async () => {
      const picker = runtime.session.prompt("/stash-list");
      await rendered();
      const outgoing = context!;
      assert.equal((await outgoing.newSession()).cancelled, false);
      await picker;
      await runtime.session.prompt("/qa-context");
      assert.throws(() => outgoing.ui.getEditorText(), /stale|invalid|disposed|active/i);
      assert.deepEqual(drafts(), ["newer mouse draft"]);
      await runtime.session.prompt("/stash branch marker");
      const marker = runtime.session.sessionManager.appendCustomEntry("qa-branch");
      assert.equal((await context!.fork(marker, { position: "at" })).cancelled, false);
      await runtime.session.prompt("/qa-context");
      const manager = runtime.session.sessionManager;
      const journal = join(home, "resume.jsonl");
      writeFileSync(journal, [manager.getHeader(), ...manager.getBranch()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      assert.equal((await context!.switchSession(journal)).cancelled, false);
      await runtime.session.prompt("/qa-context");
      await context!.reload();
      await runtime.session.prompt("/qa-context");
      assert.deepEqual(drafts(), ["branch marker", "newer mouse draft"]);
      const restore = runtime.session.prompt("/stash-list");
      await rendered();
      terminal.send("\r");
      await restore;
      assert.deepEqual(drafts(), ["newer mouse draft"]);
    });
  } finally {
    try { await cleanup?.(); } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
});
