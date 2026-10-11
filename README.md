# pi-stash

Pi Stash saves the draft you're typing in [Pi](https://github.com/earendil-works/pi) so you can send another message and return to it later. Use it when a quick question or correction interrupts a longer prompt.

![Four-step Pi Stash workflow: write a draft, save it and clear the editor with Ctrl+Shift+S, send another message, then restore or choose a draft with Ctrl+Shift+R.](.github/readme/draft-workflow.png)

Park your draft, send the interruption, then bring the draft back into the editor.

## Install

Requires Pi 1.0.0 or later and Node.js 24.15.0 or later.

```bash
pi install npm:@fitchmultz/pi-stash
```

Restart Pi after installing or updating. Then try the [draft workflow](#usage) below.

You can also install from GitHub:

```bash
pi install https://github.com/fitchmultz/pi-stash
```

## Usage

1. Start typing a draft, such as a detailed code-review request.
2. Press Ctrl+Shift+S to save it and clear the editor.
3. Type and send your other message.
4. Press Ctrl+Shift+R to bring the draft back. If you have several stashes, choose one from the picker.
5. Continue editing and send when you're ready.

Restoring into an editor that already has text pastes the draft into that text. A restored draft is removed from the stash. The footer shows how many drafts are saved.

## Commands and shortcuts

| Action | Shortcut or command |
| --- | --- |
| Save the current draft and clear the editor | Ctrl+Shift+S or `/stash` |
| Save specific text without clearing the editor | `/stash some text` |
| Restore the only draft, or choose from several | Ctrl+Shift+R |
| Browse, restore, or delete saved drafts | `/stash-list` |

In the picker, use ↑/↓ to choose a draft, Enter to restore, and Esc to cancel. Ctrl+D deletes the selected draft. Ctrl+X asks before clearing all drafts. The picker follows Pi's navigation and confirmation keybindings.

If your terminal doesn't pass a shortcut through, use `/stash` or `/stash-list`.

## Your saved drafts

You can keep up to 10 drafts per working directory, newest first. Saving an 11th drops the oldest. Blank drafts are ignored; `/stash some text` keeps leading and trailing whitespace.

Drafts are saved locally on every change, so they're still there after a restart or crash. Pi windows and sessions in the same directory share them. Avoid changing the stash in two windows at once: the last write wins.

Saved drafts are unencrypted JSON in your Pi agent directory. The [storage and client reference](docs/reference.md) has the file locations, behavior in other clients, and details on importing drafts from older versions.

## Development

The [development guide](docs/development.md) covers local installation, tests, host compatibility checks, and the automatic npm release procedure.

[Changelog](CHANGELOG.md) · [Report a problem](https://github.com/fitchmultz/pi-stash/issues)

[MIT license](LICENSE) · Created by [Mitch Fultz](https://github.com/fitchmultz)
