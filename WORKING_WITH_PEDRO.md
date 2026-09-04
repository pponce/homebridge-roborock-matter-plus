# Working With Pedro on This Project

This file records durable collaboration and operational conventions for work on Pedro's fork. It
is about **how to work together and deploy changes**, not the implementation plan for any one fix.

## Command blocks

- Put every set of commands intended for Pedro to paste into a terminal inside **one shell brace
  group**: an opening `{`, all commands, and a closing `}`.
- Do not split one procedure into commands outside that group.
- Include the `START COPY HERE` and `END COPY HERE` markers **inside** the same brace group.
- Use the real repository path when it is known. Pedro's development checkout is
  `~/devProjects/homebridge-roborock-matter-plus`; do not leave `/path/to/...` placeholders in a
  paste-ready block.
- Begin by changing to that known directory and stop the group cleanly if it is unavailable.
- Remember that `{ ...; }` runs in the current shell; it is a grouping construct, not an isolated
  script. A failed command or a bare `false` does **not** skip the remaining commands unless the
  control flow explicitly guards them.
- Put every repository-dependent command inside the successful `else` branch of the directory
  check (or behind an explicit success flag). Never use `cd /path || { echo ...; false; }` and then
  continue with unguarded Git commands: that can operate on whichever repository the shell was
  already in.
- Print section headings and explicit exit statuses so Pedro can return one bounded output block.
- Do not assume the prompt shown before a command proves which Git branch is checked out. Verify
  `git branch --show-current` and `git status --short --branch` before creating tags, merging,
  committing, or pushing.
- Do not use placeholder paths in commands described as paste-ready. If the real path is unknown,
  ask for it first.

Example shape:

```bash
{
  echo "============================================================"
  echo "START COPY HERE"
  echo "============================================================"

  if ! cd "$HOME/devProjects/homebridge-roborock-matter-plus"; then
    echo "ERROR: Could not enter the repository directory."
  else
    echo "===== CURRENT BRANCH ====="
    git branch --show-current
  fi

  echo
  echo "============================================================"
  echo "END COPY HERE"
  echo "============================================================"
}
```

## SSH and shell safety

- Pedro may run commands through an interactive SSH session. Do not use `set -e` as generic
  boilerplate in paste-ready commands.
- Never ask Pedro to `source` a diagnostic or update script. If a saved script is needed, run it as
  a child process with `bash ./script.sh`.
- Handle expected failures explicitly with `if`, `if ! command; then ... fi`, or captured exit
  statuses. Continue far enough to print the complete diagnostic output when doing so is safe.
- Because brace groups execute in the interactive shell, do not assume the closing `}` provides
  process isolation. A saved script invoked with `bash` is the appropriate choice when isolation is
  required.
- Do not use `exit`, `exec`, or `logout` in an interactive paste block. A prior diagnostic appeared
  to terminate the SSH session; its exact cause was not proven, so commands should avoid changing
  the parent shell's failure behavior.
- Do not claim that `set -e` alone caused an SSH disconnect without evidence. Check how the script
  was invoked and whether it contained an explicit session-termination path.

### Command availability on Pedro's Mint development machine

- Do not assume `rg`/ripgrep is installed. It was absent during the PR #4 integration conflict
  inspection.
- Paste-ready diagnostic blocks must either use standard `grep` for small, targeted searches or
  check `command -v rg` first and provide a `grep` fallback.
- A missing optional inspection command must not cause a block to claim that conflict resolution,
  staging, or verification succeeded. Capture and report the command's exit status explicitly.

## Branch roles

### Personal live-install branch

`schedule-refresh-recovery-live-install` is Pedro's installable integration/testing branch.

- Keep Pedro's Markdown files on this branch, including the schedule working-plan documents.
- Keep generated `dist/` on this branch. Homebridge installs the Git branch and the package entry
  point uses compiled JavaScript under `dist/`.
- Update it from Mathias's latest `upstream/main` with a normal Git merge so both histories remain
  visible.
- Never replace it with `git reset --hard upstream/main`, recreate it from upstream, or resolve all
  conflicts wholesale with `--ours` or `--theirs`.
- Before merging, update the local branch from `origin`, verify that the working tree is clean, and
  create a backup tag **only after confirming the checked-out branch name exactly matches**
  `schedule-refresh-recovery-live-install`.
- Record the tracked Markdown list before and after a merge and verify that personal files were not
  removed.

### Upstream pull-request branch

The eventual branch proposed to Mathias is separate from the personal live-install branch.

- Create it cleanly from the latest `upstream/main`.
- Include only the focused upstream-facing source, tests, and required public documentation.
- Exclude personal working-plan Markdown, personal workflow changes, historical experiments, and
  tracked `dist/` unless Mathias explicitly requests otherwise.
- Do not confuse upstream PR cleanup rules with the live-install branch: Pedro's Markdown and
  `dist/` must remain on the latter.

## Remotes and synchronization

The expected remotes are:

- `origin` fetch URL: `https://github.com/pponce/homebridge-roborock-matter-plus.git`
- `origin` push URL: `git@github.com:pponce/homebridge-roborock-matter-plus.git`
- `upstream`: `https://github.com/mathiashornbek/homebridge-roborock-matter.git`

Fetch both before deciding what "latest main" means. Do not rely on a stale local `main` branch.
Use `upstream/main` as the parent-project source and
`origin/schedule-refresh-recovery-live-install` as the fork's published live branch.

Pedro pushes to GitHub with SSH rather than entering GitHub credentials over HTTPS. Preserve HTTPS
for anonymous fetches and configure a separate SSH push URL with `git remote set-url --push`; do not
replace the fetch URL unnecessarily. Verify SSH access with an explicit SSH Git URL before pushing.
Do not put private-key contents, tokens, or passphrases into commands or returned output. An SSH key
passphrase prompt from the local agent/terminal is acceptable; a GitHub username prompt over HTTPS
means the push URL is configured incorrectly.

This fork has GitHub automation that may build and commit `dist/` after a push. A push can therefore
race a bot-generated commit.

- Never force-push to solve that race.
- Fetch `origin`, inspect the remote-only commit with `git show --stat`, and confirm what it changed.
- If it is the expected generated-build commit, rebase the local work onto the remote branch and
  push normally.
- Do not infer a bot commit's contents from its subject or from a two-tip diff.

## Building and retaining `dist/`

- Use the repository-local pinned toolchain installed with `npm ci`; do not substitute a global
  TypeScript installation.
- Run the repository's formatting, typecheck, test, and build commands before publishing a live
  branch update.
- `npm run build` regenerates `dist/`; never hand-edit compiled files or source maps.
- Review the generated diff and use `git add -f dist` when committing generated artifacts.
- A successful build that changes tracked `dist/` is expected and is not by itself a regression.
- Verify the pushed commit, not merely the local working tree, before installing it on Homebridge.

## Live Homebridge installation

After the exact tested commit is pushed to `schedule-refresh-recovery-live-install`, Pedro installs
it on the Homebridge Linux host with:

```bash
{
  echo "============================================================"
  echo "START COPY HERE"
  echo "============================================================"

  sudo hb-service stop
  STOP_STATUS=$?
  echo "hb-service stop exit status: ${STOP_STATUS}"

  if [ "${STOP_STATUS}" -eq 0 ]; then
    sudo hb-service add https://github.com/pponce/homebridge-roborock-matter-plus.git#schedule-refresh-recovery-live-install
    ADD_STATUS=$?
    echo "hb-service add exit status: ${ADD_STATUS}"
  else
    echo "Install skipped because Homebridge did not stop successfully."
  fi

  sudo hb-service start
  START_STATUS=$?
  echo "hb-service start exit status: ${START_STATUS}"

  echo
  echo "============================================================"
  echo "END COPY HERE"
  echo "============================================================"
}
```

- Give the raw Git URL to the shell, without Markdown link brackets or parentheses.
- Push before installing so the tested commit is reproducible and the branch URL resolves to it.
- After restart, confirm the plugin version/commit and perform the feature-specific live checks.
- For schedule work, verify switch presence, stable names and layout, current enabled states, and a
  disable/enable round trip while checking logs for verification or fallback errors.

## Reporting results

- Use clear copy boundaries so Pedro can return the entire command output without guessing which
  lines matter.
- Separate commands that inspect state from commands that mutate Git history or the live service.
- State explicit stop conditions before a destructive or externally visible step.
- Never treat empty output as proof that a diagnostic command succeeded. Capture and check the
  command's exit status, especially inside command substitutions or pipelines; a syntax error can
  otherwise produce an empty variable and let a safety check report a false success.
- If a merge has conflicts, stop before building or pushing and collect `git status --short`,
  `git diff --name-only --diff-filter=U`, and `git diff --check` in one brace-grouped output block.
- Do not expose credentials, Roborock tokens, LAN keys, pairing codes, or other secrets in returned
  logs.
- Never collect complete process command lines with `pgrep -a`, `ps ... args`, `/proc/*/cmdline`, or
  similar commands on Pedro's Homebridge host. Other plugins may place credentials directly in
  their command arguments. For process checks, report only PID and executable/command name, and
  inspect any additional field against a strict allowlist before printing it.
