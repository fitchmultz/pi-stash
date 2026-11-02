/**
 * Purpose: Draft-picker dialog UI for browsing and acting on stashed drafts.
 * Responsibilities: Build picker items, render the stashed-draft dialog, and translate its input into a picker result.
 * Scope: TUI dialog behavior only; storage and command orchestration live in stash.ts.
 * Usage: Imported by the extension entrypoint; showDraftPicker requires a TUI-mode context.
 * Invariants/Assumptions: The dialog settles exactly once, cancels on abort or disposal, and never mutates stored drafts itself.
 */

import {
  type ExtensionContext,
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { clampSelectedIndex, previewDraft } from "./state.ts";

export type DraftPickerResult =
  | { action: "restore"; index: number }
  | { action: "delete"; index: number }
  | { action: "clear" }
  | { action: "cancel" }
  | { action: "unsupported" };

function buildDraftItems(drafts: readonly string[]): SelectItem[] {
  return drafts.map((draft, index) => {
    const lineCount = draft.split(/\r?\n/).length;
    const latestLabel = index === 0 ? " • latest" : "";
    return {
      value: `${index}`,
      label: `${index + 1}. ${previewDraft(draft, 64)}`,
      description: `${lineCount} line${lineCount === 1 ? "" : "s"} • ${draft.length} chars${latestLabel}`,
    };
  });
}

function pickerFooter(theme: Theme): Text {
  return new Text(
    theme.fg(
      "dim",
      [
        rawKeyHint("up/down", "navigate"),
        keyHint("tui.select.confirm", "restore"),
        rawKeyHint("ctrl+d", "delete"),
        rawKeyHint("ctrl+x", "clear all"),
        keyHint("tui.select.cancel", "cancel"),
      ].join(" • "),
    ),
  );
}

function createDraftSelectList(
  items: SelectItem[],
  selectedIndex: number,
  theme: Theme,
): SelectList {
  const selectList = new SelectList(items, Math.min(items.length, 10), {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  });
  selectList.setSelectedIndex(clampSelectedIndex(selectedIndex, items.length));
  return selectList;
}

interface PickerContainerOptions {
  drafts: readonly string[];
  finish: (result: DraftPickerResult, defer?: boolean) => void;
  items: SelectItem[];
  selectedIndex: number;
}

function buildPickerContainer(
  theme: Theme,
  options: PickerContainerOptions,
): { container: Container; selectList: SelectList } {
  const container = new Container();
  container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
  container.addChild(
    new Text(theme.fg("accent", theme.bold(`Stashed Drafts (${options.drafts.length})`))),
  );

  const selectList = createDraftSelectList(options.items, options.selectedIndex, theme);
  selectList.onSelect = (item) => options.finish({ action: "restore", index: Number(item.value) });
  selectList.onCancel = () => options.finish({ action: "cancel" });
  container.addChild(selectList);

  container.addChild(pickerFooter(theme));
  container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
  return { container, selectList };
}

export async function showDraftPicker(
  ctx: ExtensionContext,
  drafts: readonly string[],
  selectedIndex: number,
  interaction: AbortController,
): Promise<DraftPickerResult> {
  if (interaction.signal.aborted) {
    return { action: "cancel" };
  }
  if (ctx.mode !== "tui") {
    return { action: "unsupported" };
  }

  const items = buildDraftItems(drafts);

  const picker = ctx.ui.custom<DraftPickerResult>((tui, theme, _keybindings, done) => {
    let settled = false;
    const finish = (result: DraftPickerResult, defer = false) => {
      if (settled) {
        return;
      }
      settled = true;
      interaction.signal.removeEventListener("abort", abort);
      if (defer) {
        queueMicrotask(() => {
          done(result);
        });
      } else {
        done(result);
      }
    };
    const abort = () => finish({ action: "cancel" });
    if (interaction.signal.aborted) {
      abort();
    } else {
      interaction.signal.addEventListener("abort", abort, { once: true });
    }
    const { container, selectList } = buildPickerContainer(theme, {
      drafts,
      finish,
      items,
      selectedIndex,
    });

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleMouse(event) {
        return container.handleMouse(event);
      },
      dispose() {
        if (settled) {
          return;
        }
        // done removes a dialog; let the host finish iterating before it runs.
        finish({ action: "cancel" }, true);
        interaction.abort();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("d"))) {
          const selected = selectList.getSelectedItem();
          if (selected) {
            finish({ action: "delete", index: Number(selected.value) });
          }
          return;
        }

        if (matchesKey(data, Key.ctrl("x"))) {
          finish({ action: "clear" });
          return;
        }

        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return await picker;
}
