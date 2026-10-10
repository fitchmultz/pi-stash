# pi-stash

`pi-stash` is a `pi` extension for parking an in-progress draft, sending something else, then restoring the draft afterward.

## Requirements

- Pi 1.0.0 or later as the support floor; qualification requires the latest stable official Pi and latest maintained fork `main`, resolving version/commit once per workflow run and retaining exact SDK/CLI evidence. Locked development dependencies are reproducible snapshots, not validation targets
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

## Shortcut configuration

Both shortcuts are configurable via `pi-stash.json` in the agent directory
(`~/.pi/agent/pi-stash.json`, or under `PI_CODING_AGENT_DIR` when set):

```json
{
  "shortcuts": {
    "stash": "ctrl+s",
    "restore": "ctrl+shift+r"
  }
}
```

Values use the same format as pi keybindings (e.g. `ctrl+s`, `ctrl+shift+s`, `alt+r`).
Set a shortcut to `false` to disable it and use the `/stash` commands instead.
Omitted values keep the defaults (`ctrl+shift+s` / `ctrl+shift+r`).
Restart Pi after changing the file.

## Behavior

- Stashes form a newest-first stack of up to 10 drafts per working directory, like `git stash` for the editor.
- The stack is saved to `~/.pi/agent/pi-stash/<hash of the directory>.json` (or under `PI_CODING_AGENT_DIR`) on every change. It survives restarts, crashes, and new sessions, and every Pi window and session in the same directory shares it.
- Restoring pastes into existing editor text instead of replacing it. RPC clients cannot merge, so they confirm before replacing the editor, and `/stash-list` prints a summary instead of the picker.
- Stash, restore, and picker actions run one at a time. Session shutdown, replacement or tree navigation dismisses an open picker or confirmation without changing the stash.
- The picker uses native keybindings and, in fullscreen, native mouse selection. Regular mode retains keyboard selection and terminal-owned scrollback.
- A footer status shows how many drafts are stashed.
- Versions before `0.3.0` stored stashes inside each session. Opening such a session imports its drafts into the project stack once.

For latest-host qualification, run `node /path/to/automation/scripts/qualify.mjs --repo pi-stash --source "$PWD" --host official --target latest --output /tmp/pi-stash-official`, then qualify the packed latest maintained fork with `--host fork --target /path/to/fork-package`. Plain `npm ci` checks only the locked development snapshot, not latest qualification.

## Automatic npm releases (maintainers)

Follow the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases): merge a reviewed PR into `main` with an intentional `package.json` version bump and a matching versioned `CHANGELOG.md` section. Once configured and enabled, publication is unattended after the existing compatibility checks and candidate-tarball qualification pass. Complete any applicable package-specific release evidence before merging the bump. Automation never bumps versions, overwrites releases, or republishes an existing version; existing manual publisher instructions remain valid.

Failed/unpublished candidates can retry daily at 12:17 UTC or via manual dispatch of `npm release` on `main`, without another bump. Set repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed. Workflow validation is not evidence of a completed real OIDC publication.

## Development

`pi` loads the extension's TypeScript directly; Node 24 runs the tests without a build step.

```bash
npm run check         # typecheck + tests + pack dry-run
npm run smoke         # isolated pi install, stash, list, and restart through the real CLI
npm run check:compat  # check + smoke; the contract GitHub runs against official Pi and the fork
```

`test/native-ui.test.ts` loads the extension through the standalone SDK and native `InteractiveMode`. It checks fullscreen and regular shortcuts, draft merging, picker cancellation and mouse selection, and fork/resume/reload restoration. The tests use an isolated profile and memory terminal, with no model or clipboard calls.

Default-limit assertions use the documented ten-draft contract, not the production constant they are checking.

The smoke test uses an isolated HOME and agent directory. It resolves the installed host's `bin.pi` (or `PI_HOST_CLI` during qualification); set `PI_BIN` to run it against another `pi` executable.
