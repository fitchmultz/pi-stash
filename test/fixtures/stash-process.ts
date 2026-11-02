/**
 * Purpose: Child-process fixture for multi-window stash concurrency tests.
 * Responsibilities: Register the real /stash command in an isolated process and report editor and notification outcomes over IPC.
 * Scope: Test support only; forked by test/concurrency.test.ts.
 * Usage: Responds to { cwd, draft, editor } messages with SaveResult replies after stashing through the real command handler.
 * Invariants/Assumptions: The mock context implements exactly the surface the stash command touches.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piStash from "../../extensions/stash.ts";

interface Notification {
  message: string;
  type: string;
}

interface FixtureContext {
  cwd: string;
  mode: "tui";
  hasUI: true;
  sessionManager: { getBranch: () => [] };
  ui: {
    theme: { fg: (_name: string, text: string) => string };
    setStatus: () => void;
    notify: (message: string, type: string) => void;
    getEditorText: () => string;
    setEditorText: (text: string) => void;
  };
}

const commands = new Map<
  string,
  { handler: (args: string, ctx: FixtureContext) => Promise<void> }
>();

const api = {
  // This fixture only exercises the /stash command; events, shortcuts, and session entries are unused.
  on(_event: unknown, _handler: unknown) {
    /* No registrations needed. */
  },
  registerShortcut(_name: unknown) {
    /* No shortcuts needed. */
  },
  appendEntry(_type: unknown) {
    /* Session entries are not persisted here. */
  },
  registerCommand(
    name: string,
    definition: { handler: (args: string, ctx: FixtureContext) => Promise<void> },
  ) {
    commands.set(name, definition);
  },
};
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-003: the fixture registers commands through a string-keyed subset of ExtensionAPI; the host interface cannot be implemented by a partial mock, and the captured handler is invoked against FixtureContext below.
piStash(api as unknown as ExtensionAPI);

// oxlint-disable-next-line typescript/no-misused-promises -- QX-006: single-shot fixture IPC. The async handler funnels every failure to process.send; an unexpected rejection would crash this child and fail the parent test's awaited once() visibly.
process.on("message", async (request: { cwd: string; draft: string; editor: boolean }) => {
  let editorText = request.editor ? request.draft : "";
  const notifications: Notification[] = [];
  const ctx: FixtureContext = {
    cwd: request.cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_name, text) => text },
      setStatus() {
        /* Status rendering is not observed here. */
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      getEditorText: () => editorText,
      setEditorText(text) {
        editorText = text;
      },
    },
  };
  const stash = commands.get("stash");
  if (stash === undefined) {
    const error = "stash command was not registered";
    process.send?.({ editorText, notifications, error });
    return;
  }
  try {
    await stash.handler(request.editor ? "" : request.draft, ctx);
    process.send?.({ editorText, notifications });
  } catch (error) {
    process.send?.({ editorText, notifications, error: String(error) });
  }
});
process.send?.({ ready: true });
