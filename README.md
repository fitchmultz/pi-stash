# pi-stash

`pi-stash` is a `pi` extension for parking an in-progress draft, sending something else, then restoring the draft afterward.

## Requirements

- Pi 1.0.0 or later; development baseline official `1.0.0`, with separate maintained-fork qualification
- Node.js `>=24.15.0` and npm for local development

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

Restart Pi after installing or updating the extension.

## Usage

1. Start typing a draft.
2. Press `Ctrl+Shift+S`.
3. Type and send the interrupting message.
4. Press `Ctrl+Shift+R`.
5. If needed, pick a different stash with the arrow keys or delete one with `Ctrl+D`.
6. Keep going with the restored draft.

## Commands and shortcuts

- `Ctrl+Shift+S` or `/stash` — stash the editor text and clear the editor
- `/stash some text` — stash explicit text exactly as provided, including leading or trailing whitespace
- `Ctrl+Shift+R` — restore the only stash, or open a picker when there are several
- `/stash-list` — browse, restore (`Enter`), delete (`Ctrl+D`), or clear all (`Ctrl+X`)

## Behavior

- Stashes form a newest-first stack of up to 10 drafts per working directory, like `git stash` for the editor.
- The stack is saved to `~/.pi/agent/pi-stash/<hash of the directory>.json` (or under `PI_CODING_AGENT_DIR`) on every change. It survives restarts, crashes, and new sessions, and every Pi window and session in the same directory shares it.
- Restoring pastes into existing editor text instead of replacing it. RPC clients cannot merge, so they confirm before replacing the editor, and `/stash-list` prints a summary instead of the picker.
- Stash, restore, and picker actions run one at a time. Session shutdown, replacement or tree navigation dismisses an open picker or confirmation without changing the stash.
- The picker uses native keybindings and, in fullscreen, native mouse selection. Regular mode retains keyboard selection and terminal-owned scrollback.
- A footer status shows how many drafts are stashed.
- Versions before `0.3.0` stored stashes inside each session. Opening such a session imports its drafts into the project stack once.

## Development

`pi` loads the extension's TypeScript directly; Node 24 runs the tests without a build step.

```bash
npm run check         # typecheck + tests + pack dry-run
npm run smoke         # isolated pi install, stash, list, and restart through the real CLI
npm run check:compat  # check + smoke; the contract GitHub runs against official Pi and the fork
```

`test/native-ui.test.ts` loads the extension through the standalone SDK and native `InteractiveMode`. It checks fullscreen and regular shortcuts, draft merging, picker cancellation and mouse selection, and fork/resume/reload restoration. The tests use an isolated profile and memory terminal, with no model or clipboard calls.

The smoke test uses an isolated HOME and agent directory. It resolves the installed host's `bin.pi` (or `PI_HOST_CLI` during qualification); set `PI_BIN` to run it against another `pi` executable.
