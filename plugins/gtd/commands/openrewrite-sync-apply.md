---
name: openrewrite-sync-apply
description: Apply half of the OpenRewrite fork sync — show which fork mains were rebased and built, launch the push in a herdr tab and watch it finish, verify the pushes, and report repos whose rebase or build failed.
---

# OpenRewrite Fork Sync Apply

Read `.llm/gtd/review/proposals/openrewrite-sync.json` and act on its status.

## Handle the staged status

- `empty`: report nothing and return success. The DAG executor advances the date.
- `error`: surface the error and return failure. Do not advance the date.
- `ready`: present the repos, push what the user approves, and report failures (below).

## Launch the push in a herdr tab

Never run `git push` to `main` yourself: a guard hook forbids it. When any proposal has an `applyOps` push, show each repo and its local commit count, then ask once with AskUserQuestion whether to push now. Put the repo list inside the question, because console output scrolls away. Options: push now, not now.

- On "not now", return skipped.
- On "push now", launch the push in a labelled herdr tab right of the review's tab. The trailing `echo` prints an exit marker for the watch below:

    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/scripts/launch-herdr-tab.mts --label openrewrite-sync -- 'openrewrite-sync --no-build; echo "[openrewrite-sync exit $?]"'
    ```

    It pushes every fork `main` that differs, each with `--force-with-lease`, and skips the rebuild prep already did. The script prints `{label, number, tabId, paneId, ...}`; read the pane with `herdr pane read <paneId>` and confirm the command started rather than sitting un-executed at a shell prompt.

- If the launch script fails (herdr unavailable, or the socket request errors), fall back to asking the user to run `! openrewrite-sync --no-build` with the command inside the question (options: pushed, not now), then verify as below.

## Watch the push to completion

Do not ask whether the push finished. Watch the pane with the Monitor tool until the exit marker appears:

```bash
until herdr pane read <paneId> --source recent --lines 200 | grep -qE '\[openrewrite-sync exit [0-9]+\]'; do sleep 5; done
```

While it runs, read the pane when Monitor reports progress or stalls. Ask with AskUserQuestion only when the pane is waiting on something only the user can do, such as an SSH key or 1Password approval prompt, and name the tab label and number inside the question. When the marker appears, read the pane once more for the exit status and any per-repo errors, then verify each staged repo with `git -C ~/projects/<repo> ls-remote origin refs/heads/main` matching the staged SHA. A mismatch because the fork moved since prep (lease rejection) is reported and left for the next run.

## Report failures

List each `failed` proposal with its detail and log path. A rebase conflict or build failure needs a fix session in that repo. Offer to start one with AskUserQuestion (start a fix now, later). For "now", launch Claude in a labelled herdr tab next to the review:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/launch-herdr-tab.mts --label <repo> -- bash -lc 'cd ~/projects/<repo> && claude "Rebase main onto upstream/main, resolve the conflicts or build failure described in <log>, and verify with git test run upstream/main..main. Do not push."'
```

## Result

- Return success when every staged push is verified, even if some repos failed to rebase or build: those reappear on the next run.
- Return skipped when the user chose "not now"; the date stays unchanged.
- Return failure when a push could not be verified for a reason other than a lease rejection.

The apply command never updates the task date. The Phase 0 executor owns it.
