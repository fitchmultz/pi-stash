# Storage and client reference

[Back to the README](../README.md)

## Shortcut configuration

Create `pi-stash.json` in your Pi agent directory. The default path is `~/.pi/agent/pi-stash.json`. If `PI_CODING_AGENT_DIR` is set, use that directory instead.

```json
{
  "shortcuts": {
    "stash": "ctrl+s",
    "restore": "ctrl+shift+r"
  }
}
```

Values use Pi keybinding strings, such as `ctrl+s`, `ctrl+shift+s`, or `alt+r`. Use different keys for stash and restore. Do not add surrounding whitespace.

Set a shortcut to `false` to disable it. `/stash` and `/stash-list` remain available. Omitted values keep the defaults: `ctrl+shift+s` for stash and `ctrl+shift+r` for restore. A missing file also keeps these defaults.

Restart Pi after you change the file.

Invalid JSON and unsupported shortcut value types cause an extension load error. The extension accepts nonblank strings without validating their keybinding syntax.

## Project-wide storage

Stashes form a newest-first stack of up to 10 drafts per working directory. Adding a draft at the limit drops the oldest and shows a notification.

The stack is saved on every change to:

```text
~/.pi/agent/pi-stash/<hash of the directory>.json
```

If `PI_CODING_AGENT_DIR` is set, the `pi-stash` directory lives under that agent directory instead. The filename is the first 16 hexadecimal characters of the SHA-256 hash of the working-directory string. Each file contains the directory and its drafts as unencrypted JSON.

Saved drafts survive Pi restarts, crashes, and new sessions, including drafts saved before the first message in a new session. All Pi windows and sessions using the same working directory and agent directory share the stack. The footer count updates when that window reads or changes the stash.

Every mutation re-reads the file, then writes a temporary file and renames it into place. Stash, restore, and picker actions run one at a time within a Pi instance. There is no cross-window lock: changes made at the same instant can still resolve last-writer-wins. Avoid simultaneous edits to the stash from separate windows.

An unreadable or invalid stash file causes an error instead of being overwritten. Stashing the editor saves the draft before clearing the editor, so a failed save leaves your current text in place.

## Editor and picker behavior

Restoring into an empty interactive editor sets its text to the draft. If the editor already contains text, restoring pastes the draft into it. A successful restore removes that draft from the stash.

With one draft, the restore shortcut restores it directly. With several, it opens a picker. `/stash-list` always opens the picker when drafts are available. The default picker keys are **↑/↓** to select a draft, **Enter** to restore it, and **Esc** to cancel. The picker supports native Pi selection and confirmation keybindings, plus **Ctrl+D** to delete the selection and **Ctrl+X** to clear all after confirmation.

Fullscreen Pi supports native mouse selection. Regular mode retains keyboard selection and terminal-owned scrollback.

Session shutdown, replacement, or tree navigation dismisses an open picker or confirmation without changing the stash. The stash stays attached to the working directory, so it does not follow session-tree branches.

## RPC and other clients

RPC clients cannot safely merge a restored draft with existing editor text. Restoring asks for confirmation before replacing the editor, even when restoring a single draft. If the client cannot show the picker, the restore shortcut uses the latest draft; `/stash-list` prints a newest-first summary instead.

Stashing the current editor, restoring, and listing require a client with editor UI support. `/stash some text` can save explicit text without reading the editor. Whitespace-only text is ignored; nonblank explicit text preserves its leading and trailing whitespace.

## Drafts from versions before 0.3.0

Older versions stored drafts inside each session. Opening such a session imports its drafts into the project stack once, skipping text already present in the stack. Existing project drafts retain priority when the combined stack exceeds 10; excess legacy drafts remain in session history.
