# pi-stash

`pi-stash` is a `pi` extension for parking an in-progress draft, sending something else, then restoring the draft afterward.

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
pi install .
```

Then run `/reload` inside `pi`.

## Design

- `Ctrl+Shift+S` stashes the current editor text and clears the editor.
- `Ctrl+Shift+R` restores immediately when there is one stash, or opens a picker when there are multiple stashes.
- The stash picker supports arrow-key navigation, `Enter` to restore, `Ctrl+D` to delete the selected stash, and `Ctrl+X` to clear all stashes.
- Restores use `pasteToEditor()` when the editor already has text, so retrieval does not destroy whatever is currently in the box.
- Drafts are kept as a small LIFO stack, so repeated stashes still work naturally.
- The current stash stack is persisted in session metadata, so `/reload` and session resume do not lose drafts.
- A footer status shows how many drafts are currently stashed.

## Commands

- `/stash` — stash the current editor text
- `/stash some text` — stash explicit text
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
