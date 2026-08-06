# pi-stash

`pi-stash` is a `pi` extension for parking an in-progress draft, sending something else, then restoring the draft afterward.

## Requirements

- Pi `0.84.0` or later, running on Node.js `>=22.19.0`
- npm for local validation and publishing

## Install

From npm:

```bash
pi install npm:@fitchmultz/pi-stash
```

From GitHub:

```bash
pi install https://github.com/fitchmultz/pi-stash
```

For local development:

```bash
npm install
pi install .
```

Then run `/reload` inside `pi`.

Pi `0.84.0` or later is required. Pi-bundled runtime packages remain optional wildcard peers as required by Pi package loading; exact `0.84.0` development dependencies define this package's validation floor.

## Development and validation

`pi` loads the extension from the source `.ts` files, but local tests are transpiled into `.tmp/test-dist/` before Node runs them so validation works on the declared Node 22.19 floor.

```bash
npm run ci            # typecheck + transpiled tests
npm run test:node22   # explicit Node 22.19 compatibility check
npm run smoke:package # isolated pi install/load smoke
npm run validate      # ci + Node 22.19 check + audit + pack dry-run + package smoke
```

## Design

- `Ctrl+Shift+S` stashes the current editor text and clears the editor.
- `Ctrl+Shift+R` restores immediately when there is one stash, or opens a picker when there are multiple stashes.
- The stash picker supports arrow-key navigation, `Enter` to restore, `Ctrl+D` to delete the selected stash, and `Ctrl+X` to clear all stashes.
- In non-TUI clients such as RPC, restore falls back to a replace-editor confirmation for the latest stash, and `/stash-list` prints a latest-first summary instead of trying to open the TUI picker.
- Restores use `pasteToEditor()` when the editor already has text, so retrieval does not destroy whatever is currently in the box.
- Drafts are kept as a small LIFO stack, so repeated stashes still work naturally.
- The current stash stack is persisted in session metadata, so `/reload`, session resume, and `/tree` branch navigation keep drafts aligned with the active branch.
- Overlapping stash, restore, and picker actions are serialized so a confirmation or picker cannot race another draft mutation.
- Session tree changes, shutdown, or replacement dismiss pending TUI confirmation dialogs and pickers before resetting the extension's in-memory state and footer status. RPC confirmations are invalidated server-side; Pi `0.84.0` does not emit a separate client cancellation frame to dismiss the remote dialog.
- A footer status shows how many drafts are currently stashed.

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
