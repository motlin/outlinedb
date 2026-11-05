---
description: Distribute project tasks to disk — match Inbox and asap-ladder tasks to the projects under Metadata > 📂 Project Directories, confirm each one, append it as a self-contained task to that project's .llm/todo.md, and open a labelled herdr tab for any project that has no pane open. Use when the user wants to push code tasks out of Workflowy into their project task lists, or run the distribute phase of the daily review.
---

# Distribute Project Tasks

Some tasks in the Inbox and on the `📌 Tasks (asap)` ladders are work inside one project on disk: a bug in a repo, a feature for a site, a cleanup in a plugin. Those belong in that project's `.llm/todo.md`, where the markdown-tasks do-one-task workflow picks them up in a session started there. This phase finds them, confirms each one, writes it to the project's task list, and makes sure a herdr tab is open in the project so the work can start.

## Do not use the built-in task list

Track progress through `.llm/` files and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`).

## Run before Rebalance

In the daily review this phase runs after the Morning Overview and **before** Rebalance Ladders and Process Inbox. A task that moves to a project's `.llm/todo.md` leaves the ladder, so distributing first means rebalance computes caps on the tasks that actually stay, and refinement never spends effort on an inbox item that is going to disk. When invoked standalone, it runs on whatever the Inbox and ladders hold now.

## Gather the inputs

Build every input from a fresh read.

- **Config.** Read `.llm/gtd/config.json` when it exists. Keys: `projectsDirectory` (the root that holds the user's repos, absolute path) and `projectDirectoriesPath` (the Workflowy path of the Project Directories node, as a comma-separated `--path` value; default `Metadata,📂 Project Directories`). Never hardcode a personal path or repo name in this phase; when `projectsDirectory` is missing, ask the user once for it through `AskUserQuestion` and write it to the config file.

- **Projects.** Export the project table and the open herdr panes, then join them:

    ```bash
    mkdir -p .llm/gtd/review
    ./bin/run.js node get --path "$(jq -r '.projectDirectoriesPath // "Metadata,📂 Project Directories"' .llm/gtd/config.json 2>/dev/null || echo "Metadata,📂 Project Directories")" --depth 3 --json \
      --fields name,shortId,id,children > .llm/gtd/review/distribute-project-dirs.json
    herdr pane list > .llm/gtd/review/distribute-panes.json
    node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-project-distribution.mts \
      --projects .llm/gtd/review/distribute-project-dirs.json \
      --panes .llm/gtd/review/distribute-panes.json \
      > .llm/gtd/review/distribute-projects.json
    ```

    Each row carries `name`, absolute `path`, `todoPath`, `todoExists`, `notGitToplevel`, the project's Workflowy tasks link (`tasksShortId`, `tasksName`), its `tags`, and `openPanes`. A row with `notGitToplevel: true` has a path that is missing or not a git toplevel (the work may live in a sibling or parent repo). Before the walk, list those projects and warn that their tasks may belong in another directory; ask which path to use rather than writing to them silently. Check the exit code of each command unpiped; a failure halts the phase. If `herdr` is not running, report it and continue with `openPanes` treated as unknown: distribute, but do not open tabs.

- **Inbox.** Load the inbox the way `${CLAUDE_PLUGIN_ROOT}/commands/inbox.md` does under **Load Inbox Data** (the inbox-loader agent writing `.llm/gtd-inboxes.json`). A `Broken inbox registration` error halts the phase.

- **Ladders.** Export each root's `📌 Tasks (asap)` bucket exactly as `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/rebalance.md` does under **Read both ladders**, to `.llm/gtd/review/ladder-<work|personal>.json`. **Never read a ladder off a mirror**: confirm `mirror.isMirror` is false on each bucket.

## Match tasks to projects

Walk every open task in the Inbox and on both ladders, including tasks inside a tier's groups. A task is a candidate when its work happens inside exactly one project's directory. Evidence, strongest first:

- It carries one of the project's `tags` (`#animal-kingdom`), or links to the project's tasks node (`tasksShortId`).
- It names the project, its repo, or its site.
- Its subtree names files, commands, or features that only that project has. Confirm with a quick `ls` or `grep` in the project's `path` when the name alone is ambiguous.

Skip a task when:

- It spans several projects, or it belongs to no project at all. Do not create directories or invent paths.
- Its next step happens outside the code: a purchase, an email, a call, a decision, or waiting on someone.
- It is already tracked there. Grep the project's `todoPath` (when `todoExists`) for the task's Workflowy link, `workflowy.com/#/<shortId>`, before proposing it. Every distributed task carries that link as provenance, so a task kept open in Workflowy by **Distribute, keep in Workflowy** is recognized on later runs even after its text was reworded. Also grep for the task's key phrase, which catches tasks added there by other routes.
- It is a `#llm-task` recurring item. Those run through the LLM Tasks DAG, not a project's task list.

Read each candidate's subtree (children, note, links) before proposing it, per **Show the item, do not just name it** in `${CLAUDE_PLUGIN_ROOT}/skills/due-item-walk.md`. Write the proposals to `.llm/gtd/review/distribute-candidates.json` (one entry per task: Workflowy `id`, `shortId`, source `inbox` or `ladder-<root>`, project `name`, and the drafted task text) so the walk survives a compacted conversation.

## Locate unmapped project directories

A task that names a project (tag, link, or name) with no row in the project table is not skipped. Resolve it:

- Search `projectsDirectory` from the config for a directory whose git toplevel name matches the project name (`find <projectsDirectory> -maxdepth 2 -name .git`, then compare the parent directory name case-insensitively). Confirm with `git -C <dir> rev-parse --show-toplevel`.
- Ask through `AskUserQuestion` whether to register it: show the found path and offer **Add to Project Directories** (create the project node under the Project Directories node with the path as its first child, per the Project Directory Mapping convention), **Wrong directory** (user gives the path in Other), and **Leave unmapped**. When nothing matches, say so and skip the task.
- Once mapped, rebuild the project row (re-run the join) and continue with the task as usual.

## Check for already-done work

Before asking about any candidate, look for evidence it is already finished. Work on a project often happens in a sibling repo or on an unmerged branch, so search the whole repo family, not just the matched project:

- Build the repo family: the matched project's `path`, every Project Directories row sharing one of its `tags` or its name stem, and every git toplevel under `projectsDirectory` whose directory name contains that stem (for a `#widget` task, `<projectsDirectory>/*widget*`). Include worktree peers.
- In each repo, grep `.llm/todo.md` and archived task lists (`.llm/*-todo*.md`) for items (`- [x]` done, `- [ ]` queued, `- [!]` blocked) matching the task's Workflowy link or key phrase.
- In each repo, run `git -C <repo> log --all --oneline -i --grep=<key phrase>` so commits on every local and remote-tracking branch count, not only the checked-out one. Try two or three distinctive phrases from the task, not just its title.

Classify the result as **full** (a matching commit or `- [x]` item covers the whole task), **partial** (some of it is committed or queued, or the match sits on an unmerged branch), or **none**. Always state the classification and which repos and branches were searched in the question, with each matching line or commit (`repo@branch sha subject`).

When evidence is full, list **Complete** first: complete the Workflowy task with `./bin/run.js node complete --id <uuid>` and confirm it reads back completed, without appending anything to the project. When evidence is partial, name the remaining work in the drafted task text so the project session only does what is left. When there is none, continue to drafting.

## Draft the task text

The project's session reads the task in isolation, so the text must stand alone. Follow the markdown-tasks **Standalone Context** rule:

- First line: an imperative summary of the work, rewritten from the Workflowy name with HTML and tags stripped.
- Indented context lines: every fact in the item's subtree, the Workflowy link (`https://workflowy.com/#/<shortId>`) as provenance, and any URLs it holds. Use absolute paths inside the project.
- Never paste people's personal details beyond what the task needs.

## Confirm one task per question

Ask about one task per question through `AskUserQuestion`; one call may carry up to 4 questions, never two tasks in one question. Do not open with a question about how many tasks to cover. Each question names the task, where it sits now, the project it would go to with the evidence, and shows the drafted first line. Options:

- **Distribute** — append it to the project's `.llm/todo.md`, then complete the Workflowy task.
- **Distribute, keep in Workflowy** — append it, and leave the Workflowy task open.
- **Wrong project** — the user names the right one in Other; re-check that project's `path` and ask again.
- **Leave it** — no change.

Put the drafted task text inside the question itself, not only in the surrounding text, so the user sees what will be written.

## Write each accepted task

Append through the markdown-tasks script, never by editing the file by hand:

```bash
python3 "$(ls -d ~/.claude/plugins/cache/*/markdown-tasks/*/scripts | sort -V | tail -n 1)/task_add.py" \
  <todoPath> "<first line>
  <context line>
  <context line>"
```

Use `python3`: the bare `python` shim can be unset under mise. The script creates `.llm/` and `todo.md` when they are missing. Read the task back with `grep -F "<first line>" <todoPath>` before touching Workflowy; a missing line halts that item and leaves the Workflowy task open.

On **Distribute**, complete the Workflowy task with `./bin/run.js node complete --id <uuid>` and confirm it reads back completed. Never complete it before the read-back of the todo line succeeds.

Do not commit or stage anything in the project's repository; `.llm/` is that project's own concern.

## Open a herdr tab where none is open

After the walk, for each project that received at least one task and has an empty `openPanes`, open one labelled tab in this session's workspace, never the focused one. Follow every rule in **Cross-project #llm-task launches** in `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/due.md`:

```bash
herdr pane current   # .result.pane.workspace_id
herdr tab create --workspace <workspace_id> --cwd <path> --label <project name> --no-focus
```

`--label` is required and is the project's `name`. Open one tab per project, however many tasks it received. Verify with `herdr pane read <root_pane.pane_id>` that the tab is a shell in the project directory. Do not start an agent or send a prompt; the user starts the work when they switch to the tab.

A project that already has an open pane gets no new tab. Name the existing tab in the summary instead.

## Finish

Print one line, e.g. `✓ Distributed 3 tasks: animal-kingdom (2, tab opened), liftwizard (1, already open) · 2 left in Workflowy`. Silent when no task matched a project.

The review's rules still hold here: never offer to pause or wrap up because the list is long, and an improvement idea goes to `.llm/gtd/review/mid-run-notes.md` rather than stopping the walk.
