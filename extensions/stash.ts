/**
 * Purpose: Add fast stash-and-restore draft workflow to the pi editor.
 * Responsibilities: Persist the stash per project directory, expose stash/restore commands and shortcuts, and orchestrate picker interactions.
 * Scope: Interactive editor draft management shared by every pi session in one working directory.
 * Usage: Install as a pi package, then use Ctrl+Shift+S to stash and Ctrl+Shift+R to restore or pick from multiple drafts.
 * Invariants/Assumptions: Drafts are restored newest-first by default, blank drafts are never stashed, the project file is re-read before every mutation, and non-TUI clients use confirmation or summary flows.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { showDraftPicker } from "./picker.ts";
import {
  countLabel,
  errnoCode,
  hydrateState,
  isBlankDraft,
  isRecord,
  latestDraft,
  MAX_STASHED_DRAFTS,
  previewDraft,
  pushDraft,
  readDrafts,
  STASH_ENTRY_TYPE,
  withoutDraft,
} from "./state.ts";

export const DEFAULT_SHORTCUTS = {
  stash: "ctrl+shift+s",
  restore: "ctrl+shift+r",
} satisfies Record<string, KeyId>;

export interface StashShortcutsConfig {
  shortcuts?: {
    stash?: KeyId | false;
    restore?: KeyId | false;
  };
}

export function stashConfigFile(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pi-stash.json");
}

function resolveShortcut(
  value: unknown,
  fallback: KeyId,
  name: string,
  file: string,
): KeyId | false {
  if (value === undefined) {
    return fallback;
  }
  if (value === false) {
    return false;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- QX-002: pi-tui exposes no runtime KeyId validator (dist/keys.d.ts), so a validated non-empty keybinding string is trusted as KeyId; invalid bindings fail open because the shortcut never matches input.
    return value as KeyId;
  }
  throw new Error(`Invalid shortcuts.${name} in ${file}: expected a keybinding string or false`);
}

function readConfig(file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${file}: ${message}`, { cause: error });
  }
}

export function resolveShortcuts(agentDir: string = getAgentDir()): {
  stash: KeyId | false;
  restore: KeyId | false;
} {
  const file = stashConfigFile(agentDir);
  const parsed = readConfig(file);
  if (parsed === undefined) {
    return { ...DEFAULT_SHORTCUTS };
  }
  if (!isRecord(parsed)) {
    throw new Error(`Invalid config in ${file}: expected a JSON object`);
  }
  const shortcuts = "shortcuts" in parsed ? parsed.shortcuts : undefined;
  if (shortcuts === undefined || shortcuts === null) {
    return { ...DEFAULT_SHORTCUTS };
  }
  if (!isRecord(shortcuts)) {
    throw new Error(`Invalid shortcuts in ${file}: expected an object`);
  }
  const stash = "stash" in shortcuts ? shortcuts.stash : undefined;
  const restore = "restore" in shortcuts ? shortcuts.restore : undefined;
  return {
    stash: resolveShortcut(stash, DEFAULT_SHORTCUTS.stash, "stash", file),
    restore: resolveShortcut(restore, DEFAULT_SHORTCUTS.restore, "restore", file),
  };
}

function stashFile(cwd: string): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(getAgentDir(), "pi-stash", `${key}.json`);
}

function loadDrafts(cwd: string): string[] {
  const file = stashFile(cwd);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      throw error;
    }
    return [];
  }
  // Refuse to overwrite a file we cannot read back; it may hold the user's only copy of a draft.
  const drafts = readDrafts(JSON.parse(text));
  if (!drafts) {
    throw new Error(`Invalid stash file: ${file}`);
  }
  return drafts;
}

function saveDrafts(cwd: string, drafts: readonly string[]): void {
  const file = stashFile(cwd);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ cwd, drafts })}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function updateStatus(ctx: ExtensionContext, drafts: readonly string[]): void {
  ctx.ui.setStatus(
    "pi-stash",
    drafts.length === 0 ? undefined : ctx.ui.theme.fg("accent", `📦 ${countLabel(drafts.length)}`),
  );
}

function updateDrafts(ctx: ExtensionContext, update: (drafts: string[]) => string[]): string[] {
  const lock = `${stashFile(ctx.cwd)}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST" || attempt === 50) {
        throw error;
      }
      // Only mkdir grants ownership. Never reclaim by age: the owner may just be paused.
      Atomics.wait(wait, 0, 0, 20);
    }
  }
  let drafts: string[];
  try {
    drafts = update(loadDrafts(ctx.cwd));
    saveDrafts(ctx.cwd, drafts);
  } finally {
    rmdirSync(lock);
  }
  updateStatus(ctx, drafts);
  return drafts;
}

function ensureEditor(ctx: ExtensionContext, action: string): boolean {
  if (ctx.hasUI) {
    return true;
  }
  ctx.ui.notify(`${action} requires the interactive editor`, "warning");
  return false;
}

function stashDraft(ctx: ExtensionContext, draft: string): void {
  const outcome = { dropped: false };
  const drafts = updateDrafts(ctx, (current) => {
    outcome.dropped = current.length >= MAX_STASHED_DRAFTS;
    return pushDraft(current, draft);
  });
  ctx.ui.notify(
    `Stashed ${countLabel(drafts.length)}: ${previewDraft(draft)}${outcome.dropped ? " Oldest draft dropped." : ""}`,
    "info",
  );
}

function stashEditor(ctx: ExtensionContext): void {
  if (!ensureEditor(ctx, "Stashing")) {
    return;
  }

  const draft = ctx.ui.getEditorText();
  if (isBlankDraft(draft)) {
    ctx.ui.notify("Nothing to stash", "warning");
    return;
  }

  stashDraft(ctx, draft);
  ctx.ui.setEditorText("");
}

async function restoreDraft(
  ctx: ExtensionContext,
  draft: string,
  interaction: AbortController,
): Promise<void> {
  if (!ensureEditor(ctx, "Restoring")) {
    return;
  }

  if (ctx.mode === "rpc") {
    const confirmed = await ctx.ui.confirm(
      "Replace editor with stashed draft?",
      "This non-TUI client cannot safely merge stashed drafts with existing editor text. Restoring will replace the current editor contents.",
      { signal: interaction.signal },
    );
    if (interaction.signal.aborted) {
      return;
    }
    if (!confirmed) {
      ctx.ui.notify("Restore cancelled", "info");
      return;
    }
  }
  updateDrafts(ctx, (current) => {
    if (ctx.mode === "rpc" || isBlankDraft(ctx.ui.getEditorText())) {
      ctx.ui.setEditorText(draft);
    } else {
      ctx.ui.pasteToEditor(draft);
    }
    return withoutDraft(current, draft);
  });
  ctx.ui.notify(`Restored draft: ${previewDraft(draft)}`, "info");
}

async function handleUnsupportedClient(
  ctx: ExtensionContext,
  drafts: readonly string[],
  interaction: AbortController,
  onUnsupported: "list" | "restore-latest",
): Promise<void> {
  if (onUnsupported === "restore-latest") {
    ctx.ui.notify(
      "Stash picker unavailable in this client; using the latest stash for restore.",
      "info",
    );
    const latest = latestDraft(drafts);
    if (latest !== undefined) {
      await restoreDraft(ctx, latest, interaction);
    }
    return;
  }
  const summary = drafts
    .map((draft, index) => `${index + 1}. ${previewDraft(draft, 64)}`)
    .join("\n");
  ctx.ui.notify(`Stashed drafts (latest first):\n${summary}`, "info");
}

async function clearStashes(
  ctx: ExtensionContext,
  interaction: AbortController,
): Promise<"cleared" | "kept" | "aborted"> {
  const confirmed = await ctx.ui.confirm("Clear all stashes?", "Delete all stashed drafts?", {
    signal: interaction.signal,
  });
  if (interaction.signal.aborted) {
    return "aborted";
  }
  if (!confirmed) {
    return "kept";
  }
  updateDrafts(ctx, () => []);
  ctx.ui.notify("Cleared stashed drafts", "info");
  return "cleared";
}

async function browseDrafts(
  ctx: ExtensionContext,
  initialDrafts: readonly string[],
  interaction: AbortController,
  onUnsupported: "list" | "restore-latest",
): Promise<void> {
  let drafts = [...initialDrafts];
  let selectedIndex = 0;
  while (drafts.length > 0) {
    const result = await showDraftPicker(ctx, drafts, selectedIndex, interaction);
    if (interaction.signal.aborted) {
      return;
    }

    if (result.action === "unsupported") {
      return handleUnsupportedClient(ctx, drafts, interaction, onUnsupported);
    }

    if (result.action === "cancel") {
      return;
    }

    if (result.action === "clear") {
      const outcome = await clearStashes(ctx, interaction);
      if (outcome !== "kept") {
        return;
      }
      continue;
    }

    const draft = drafts[result.index];
    if (draft === undefined) {
      ctx.ui.notify("No stashed draft at that position", "warning");
      selectedIndex = 0;
      continue;
    }
    if (result.action === "restore") {
      return restoreDraft(ctx, draft, interaction);
    }

    drafts = updateDrafts(ctx, (current) => withoutDraft(current, draft));
    ctx.ui.notify(`Deleted stashed draft: ${previewDraft(draft)}`, "info");
    selectedIndex = result.index;
  }
}

async function manageDrafts(
  ctx: ExtensionContext,
  interaction: AbortController,
  onUnsupported: "list" | "restore-latest",
): Promise<void> {
  if (!ensureEditor(ctx, "Listing stashes")) {
    return;
  }
  const drafts = loadDrafts(ctx.cwd);
  if (drafts.length === 0) {
    ctx.ui.notify("No stashed drafts", "info");
    return;
  }
  await browseDrafts(ctx, drafts, interaction, onUnsupported);
}

async function restoreLatestOrPick(
  ctx: ExtensionContext,
  interaction: AbortController,
): Promise<void> {
  const drafts = loadDrafts(ctx.cwd);
  if (drafts.length === 0) {
    ctx.ui.notify("No stashed drafts", "warning");
    return;
  }
  const latest = latestDraft(drafts);
  if (latest === undefined) {
    return;
  }
  if (drafts.length === 1) {
    return restoreDraft(ctx, latest, interaction);
  }
  return manageDrafts(ctx, interaction, "restore-latest");
}

function importSessionDrafts(pi: ExtensionAPI, ctx: ExtensionContext): void {
  // Releases before 0.3.0 kept the stash in session entries.
  const legacy = hydrateState(ctx.sessionManager.getBranch());
  if (legacy.length === 0) {
    updateStatus(ctx, loadDrafts(ctx.cwd));
    return;
  }

  const outcome = { imported: 0, dropped: 0 };
  updateDrafts(ctx, (current) => {
    const added = legacy.filter((draft) => !current.includes(draft));
    outcome.imported = added.length;
    outcome.dropped = Math.max(0, current.length + added.length - MAX_STASHED_DRAFTS);
    return [...current, ...added].slice(0, MAX_STASHED_DRAFTS);
  });
  pi.appendEntry(STASH_ENTRY_TYPE, { drafts: [] });
  if (outcome.imported === 0) {
    return;
  }
  const suffix =
    outcome.dropped > 0
      ? ` ${countLabel(outcome.dropped)} over the limit stayed in the session history.`
      : "";
  ctx.ui.notify(
    `Imported ${countLabel(outcome.imported)} from this session into the project stash.${suffix}`,
    "info",
  );
}

type Enqueue = (operation: () => void | Promise<void>) => Promise<void>;
type EnqueueInteraction = (
  operation: (interaction: AbortController) => Promise<void>,
) => Promise<void>;

function registerShortcutsAndCommands(
  pi: ExtensionAPI,
  enqueue: Enqueue,
  enqueueInteraction: EnqueueInteraction,
): void {
  const shortcuts = resolveShortcuts();

  if (shortcuts.stash !== false) {
    pi.registerShortcut(shortcuts.stash, {
      description: "Stash the current draft and clear the editor",
      handler: (ctx) => enqueue(() => stashEditor(ctx)),
    });
  }

  if (shortcuts.restore !== false) {
    pi.registerShortcut(shortcuts.restore, {
      description: "Restore the latest stashed draft, or pick from multiple drafts",
      handler: (ctx) => enqueueInteraction((interaction) => restoreLatestOrPick(ctx, interaction)),
    });
  }

  pi.registerCommand("stash", {
    description: "Stash the current editor draft, or stash the provided text",
    handler: (args, ctx) =>
      enqueue(() => {
        if (args.length === 0) {
          stashEditor(ctx);
          return;
        }
        if (isBlankDraft(args)) {
          ctx.ui.notify("Nothing to stash", "warning");
          return;
        }
        try {
          stashDraft(ctx, args);
        } catch (error) {
          if (ctx.hasUI && isBlankDraft(ctx.ui.getEditorText())) {
            ctx.ui.setEditorText(args);
          }
          throw error;
        }
      }),
  });

  pi.registerCommand("stash-list", {
    description: "Browse stashed drafts, restore one, delete one, or clear all",
    handler: (_args, ctx) =>
      enqueueInteraction((interaction) => manageDrafts(ctx, interaction, "list")),
  });
}

export default function piStash(pi: ExtensionAPI): void {
  let generation = 0;
  let pendingInteraction: AbortController | undefined;
  let pendingOperation: Promise<null> = Promise.resolve(null);

  const enqueue: Enqueue = (operation) => {
    const requestedGeneration = generation;
    const run = () => (requestedGeneration === generation ? operation() : undefined);
    const result = pendingOperation.then(run, run);
    // The serialization token settles to null regardless of outcome so later enqueues always run.
    const settle = (): null => null;
    pendingOperation = result.then(settle, settle);
    return result;
  };

  const enqueueInteraction: EnqueueInteraction = (operation) =>
    enqueue(async () => {
      const interaction = new AbortController();
      pendingInteraction = interaction;
      try {
        await operation(interaction);
      } finally {
        if (pendingInteraction === interaction) {
          pendingInteraction = undefined;
          // Native disposal can cancel before the host emits session_shutdown.
          if (interaction.signal.aborted) {
            generation++;
          }
        }
      }
    });

  const reset = () => {
    generation++;
    pendingInteraction?.abort();
    pendingInteraction = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    reset();
    importSessionDrafts(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    ctx.ui.setStatus("pi-stash", undefined);
  });

  pi.on("session_tree", (_event, ctx) => {
    reset();
    updateStatus(ctx, loadDrafts(ctx.cwd));
  });

  registerShortcutsAndCommands(pi, enqueue, enqueueInteraction);
}
