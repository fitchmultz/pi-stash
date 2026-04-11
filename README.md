# pi-stash

`pi-stash` is a `pi` extension for parking an in-progress draft, sending something else, then restoring the draft afterward.

## Requirements

- `pi` running on Node.js `>=20.6.0`
- npm for local validation and publishing

## Install

From npm:

```bash
pi install npm:@fitchmultz/pi-stash
```

From a tagged GitHub release:

```bash
pi install https://github.com/fitchmultz/pi-stash@v0.1.2
```

For local development:

```bash
npm install
pi install .
```

Then run `/reload` inside `pi`.

## Development and validation

`pi` loads the extension from the source `.ts` files, but local tests are transpiled into `.tmp/test-dist/` before Node runs them so validation works on the declared Node 20.6 floor.

```bash
npm run ci          # typecheck + transpiled tests
npm run test:node20 # explicit Node 20.6 compatibility check
npm run validate    # ci + Node 20.6 check + audit + pack dry-run
```

## Design

- `Ctrl+Shift+S` stashes the current editor text and clears the editor.
- `Ctrl+Shift+R` restores immediately when there is one stash, or opens a picker when there are multiple stashes.
- The stash picker supports arrow-key navigation, `Enter` to restore, `Ctrl+D` to delete the selected stash, and `Ctrl+X` to clear all stashes.
- When custom TUI overlays are unavailable (for example some RPC clients), restore falls back to a replace-editor confirmation for the latest stash, and `/stash-list` prints a latest-first summary instead of crashing.
- Restores use `pasteToEditor()` when the editor already has text, so retrieval does not destroy whatever is currently in the box.
- Drafts are kept as a small LIFO stack, so repeated stashes still work naturally.
- The current stash stack is persisted in session metadata, so `/reload`, session resume, and `/tree` branch navigation keep drafts aligned with the active branch.
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
