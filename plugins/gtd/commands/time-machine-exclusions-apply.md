---
name: time-machine-exclusions-apply
description: Silently finish a clean Time Machine exclusion check or ask the user to run and verify the fixed-path sweep when prep found unmatched build directories.
---

# Time Machine Exclusions Apply

Read `.llm/gtd/review/proposals/time-machine-exclusions.json` and act on its status.

## Handle the staged status

- `empty`: report nothing and return success. The DAG executor advances the date without prompting.
- `error`: surface the error and return failure. Do not advance the date.
- `ready`: offer to remove clean worktrees first (below), then show `summary.report` (each durable path, plus one aggregate line per repo for build dirs inside `.worktrees/` and one each for build dirs inside `.llm/conflicts-*/` checkouts, `.llm/pr-*-repair/` checkouts, and `.yarn/unplugged/` packages), launch the staged sweep command in a herdr tab and watch it to completion (below). Never expand an aggregate into individual paths, and never suggest excluding or skipping a `.worktrees` root -- a worktree with uncommitted changes needs backing up.

## Remove clean worktrees before the sweep

Removing a fully-committed worktree deletes its build output outright, which beats excluding it. When `summary.worktreeCandidates` has entries with `clean: true` and `idle: true`, ask with AskUserQuestion before launching the sweep. Put the list inside the question: each worktree's path, branch, and build-dir count. Options: remove all clean worktrees, pick which ones, keep them all.

- Offer only entries that are both `clean: true` and `idle: true` (nothing edited in the last hour, no process inside). List the rest as a count in the question so the user knows they exist, and never offer to remove them.
- Remove the accepted worktrees with the script, which runs `git worktree remove` **without `--force`**:

    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/scripts/find-removable-worktrees.mts --remove <worktree>...
    ```

    It prints `[{path, removed, error?}]`. Report each refusal (git's own message, such as modified or untracked files or a locked worktree) and leave that worktree in place. Never retry with `--force`, never `rm -rf` a worktree, and never delete its branch.

- After any removal, rerun the scan and grouping from `/gtd:time-machine-exclusions-prep` and replace the staged `summary.directories` and `summary.report` with the rescan's result, so the sweep and verification cover only the remainder. The sweep script rescans on its own, so it already skips the removed paths.
- When the rescan finds nothing, return success without launching the sweep.

## Launch the sweep in a herdr tab

Do not tell the user to copy the command into another terminal. Start it for them in a new herdr tab, which is a real terminal, so `sudo` can prompt for the password there:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/launch-herdr-tab.mts --label time-machine -- '<staged sweep command>; echo "[time-machine exit $?]"'
```

Pass the resolved absolute sweep path from the proposal. The trailing `echo` prints an exit marker for the watch below. The script resolves this session's own pane with `herdr pane current`, creates a focused tab labelled `time-machine` in that workspace, moves it to sit **immediately right of the review's tab** (`herdr tab create` alone appends it last, and the CLI has no move command, so the script uses the socket API's `tab.move`), and runs the command there. It prints `{label, number, tabId, paneId, workspaceId, rightOfTabId}`.

- Always keep `--label time-machine`. An unlabelled tab shows only its number, and the user cannot find it.
- Read the pane back with `herdr pane read <paneId>` and confirm the script started (a `Password:` prompt or scan output), not a bare shell prompt with the command un-executed.

Then ask with AskUserQuestion only for what needs the user: the sudo password. Put everything they must act on inside the question itself, since the surrounding console output scrolls away:

- The tab label (`time-machine`), its number, and that it sits immediately right of the review's tab.
- That the script is waiting for their sudo password and they must type it in that tab.
- Options: typed it, skip.

On skip, return skipped and leave the date unchanged. Never ask whether the sweep finished; start the watch below right after the launch, without waiting on the answer.

If the launch script fails (herdr unavailable, or the socket request errors), fall back to showing the command and telling the user to run it in Terminal or iTerm -- never through Claude Code's `!` prefix, which has no terminal for the password prompt. Only in this fallback, with no pane to watch, ask whether it finished (options: finished, skip).

## Verify

Watch the pane with the Monitor tool until the exit marker appears:

```bash
until herdr pane read <paneId> --source recent --lines 200 | grep -qE '\[time-machine exit [0-9]+\]'; do sleep 5; done
```

If the pane shows a fresh `Password:` or `Sorry, try again` prompt while watching, ask again for the password the same way. When the marker appears, read the pane once more for the exit status, then rerun the no-sudo check from `/gtd:time-machine-exclusions-prep` before returning success.

Verify against the **staged** `summary.directories` list (the post-removal rescan's list when worktrees were removed), not the raw scan total. Build directories appear constantly on this machine (every new worktree adds `node_modules`), so a fresh scan almost always finds paths that did not exist when prep ran. Failing on those makes the task permanently unsatisfiable.

- Every staged path now excluded → success, even when the rescan lists new paths. Report the new ones as a count so the next run picks them up; a rescan that only finds worktree churn is still success.
- Any staged path still unexcluded, or the check itself errors → show the result and return failure; never advance based on confirmation alone.

The apply command never runs `sudo` and never updates the task date. The Phase 0 executor owns the name-matched date operation.
