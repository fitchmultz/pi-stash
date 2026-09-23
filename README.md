# pi-stash

`pi-stash` is a `pi` extension for parking an in-progress draft, sending something else, then restoring the draft afterward.

## Requirements

- Pi `0.84.0` or later, running on Node.js `>=22.19.0`
- npm for local validation

## Install

From GitHub:

```bash
pi install https://github.com/fitchmultz/pi-stash
```

For local development:

```bash
npm install
pi install .
```

Restart Pi after installing or updating extension code or dependencies. The maintained fork's `/reload` refreshes resources and reinitializes cached extension code; it is not code-update activation.

Pi `0.84.0` remains the declared floor. Pi-bundled runtime packages remain optional wildcard peers as required by Pi package loading; exact official `0.86.1` development dependencies define the current qualification baseline, not a promise that every intermediate release was tested.

## Development and validation

`pi` loads the extension from the source `.ts` files, but local tests are transpiled into `.tmp/test-dist/` before Node runs them so validation works on the declared Node 22.19 floor.

```bash
npm run check:compat  # typecheck + transpiled tests + pack dry-run + native install/load smoke
npm run ci            # typecheck + transpiled tests
npm run test:node22   # explicit Node 22.19 compatibility check
npm run smoke:package # isolated pi install/load smoke
npm run validate      # ci + Node 22.19 check + audit + pack dry-run + package smoke
```

The smoke test resolves the installed host's actual `bin.pi` entry (or `PI_HOST_CLI` in qualification) and uses an isolated HOME/agentDir. `PI_COMPAT_EXPECTED_VERSION` and `PI_COMPAT_EXPECTED_PACKAGE_DIR` assert the selected host. The standalone `PI_BIN` override remains available outside compatibility jobs. GitHub PR checks qualify the declared official Pi version and the maintained fork on Node 22.19; Node 26 is an advisory check. They exercise stash, list, and restart/resume through the real CLI, but do not trigger a native checkpoint or test Windows. No production build or `prepare` is needed for this package; Pi loads the shipped TypeScript directly.

## Design

- `Ctrl+Shift+S` stashes the current editor text and clears the editor.
- `Ctrl+Shift+R` restores immediately when there is one stash, or opens a picker when there are multiple stashes.
- The stash picker supports arrow-key navigation, `Enter` to restore, `Ctrl+D` to delete the selected stash, and `Ctrl+X` to clear all stashes.
- In non-TUI clients such as RPC, restore falls back to a replace-editor confirmation for the latest stash, and `/stash-list` prints a latest-first summary instead of trying to open the TUI picker.
- Restores use `pasteToEditor()` when the editor already has text, so retrieval does not destroy whatever is currently in the box.
- Drafts are kept as a small LIFO stack, so repeated stashes still work naturally.
- The current stash stack is persisted in session metadata, so `/reload`, session resume, and `/tree` branch navigation keep drafts aligned with the active branch.
- On Pi versions that wait for the first assistant reply before saving a new session, each early stash update creates a resumable **Stashed drafts** session. `pi -c` opens the latest one; `/resume` can select earlier copies. Clearing a recovery session affects only that session. Pi-stash removes unused copies once the original session saves, while a recovery session you opened remains yours.
- Overlapping stash, restore, and picker actions are serialized so a confirmation or picker cannot race another draft mutation.
- Session tree changes, shutdown, or replacement dismiss pending TUI confirmation dialogs and pickers before resetting the extension's in-memory state and footer status. RPC confirmations are invalidated server-side; Pi `0.84.0` does not emit a separate client cancellation frame to dismiss the remote dialog.
- A footer status shows how many drafts are currently stashed.
- On Pi forks supporting `session_checkpoint`, idle stashes qualify through their existing selected-branch entries. Live pickers/confirmations, queued operations, and editor drafts must finish through native ownership; checkpointing never stashes, discards, or cancels user work. Shutdown cleanup remains unchanged. Older Pi hosts ignore the additive hook.

## Commands

- `/stash` — stash the current editor text
- `/stash some text` — stash explicit text exactly as provided, including leading or trailing whitespace
- `/stash-list` — browse, restore, delete, or clear stashes

## Why `Ctrl+Shift+R` for retrieval?

`Ctrl+Shift+S` appears free in the current `pi` keybinding docs, and `Ctrl+Shift+R` is also currently unassigned and mnemonic for **restore**.

## Usage flow

1. Start typing a draft.
2. Press `Ctrl+Shift+S`.
3. Type and send the interrupting message.
4. Press `Ctrl+Shift+R`.
5. If needed, pick a different stash with the arrow keys or delete one with `Ctrl+D`.
6. Keep going with the restored draft.
