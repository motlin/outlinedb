---
description: Close the daily review by offering to do real work together — on items overdue, due now, or due within the week; on the 1st tier of both asap ladders; and on items this run filed while their context is fresh. Each candidate names the concrete help on offer and is its own question; accepted items are worked on the spot. Use when the user wants to work through their most pressing tasks with Claude, or run the work-together phase of the daily review.
---

# Work Together

The rest of the review sorts, ranks, and dates work. This phase does some of it. With the ladders ranked and the dated items walked, look at what is left and offer to work on the items where Claude can actually help, right now, in this session.

Scope is **both** roots linked from `Metadata > ☑️ Next Actions` (id: `nextActionsId` from `.llm/gtd/config.json`, asking once and saving it when missing), Work and Personal, discovered by link resolution and never hardcoded, plus Things 3 and Apple Reminders for the dated category.

## Do not use the built-in task list

Track progress through `.llm/` files and inline status updates. Do **not** create Claude Code built-in tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) for the per-item work here.

## Run last

In the daily review this phase runs after the Recurring Review. It needs the due walk's handled outcomes so it never offers help on something the user just called done, and the rebalanced `1st` tier so the ranking it reads is today's. When invoked standalone, it runs on whatever the ladders and buckets hold now.

## Gather the three categories

Build every category from a **fresh** read. The earlier phases moved, completed, and rescheduled items, so any export they left in `.llm/gtd/review/` is stale for this purpose.

- **Due now or soon.** Re-run the Workflowy Next-Actions and Things fetches from `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/due.md` under **Fetch every source before the first question**, overwriting `due-workflowy.json` and `due-things.json`. Reuse the staged `due-reminders.json`; do not launch `reminders-fetcher` again. Then collect with a one-week horizon:

    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/scripts/collect-due-items.mts \
      --workflowy .llm/gtd/review/due-workflowy.json \
      --things .llm/gtd/review/due-things.json \
      --reminders .llm/gtd/review/due-reminders.json \
      --horizon-days 7 \
      > .llm/gtd/review/work-together-due.json
    ```

    A negative `overdueByDays` means the item is due that many days from now. Drop every row that already has a handled (non-`skip`) record dated today in `.llm/gtd/review/skip-log.jsonl` under its `<source>:<id>` key; the user just dealt with it. An item the due walk already worked through **Help me do it now** in `${CLAUDE_PLUGIN_ROOT}/skills/due-item-walk.md` but left open keeps its child node recording where the work stopped; offer to resume from that point rather than starting over.

- **`1st` tier.** Export each root's `📌 Tasks (asap)` bucket and read `dayPlan` from the `rebalance` report exactly as `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/rebalance.md` does under **Read both ladders**. Take the `1st` tier's items only. **Never read a ladder off a mirror**: confirm `mirror.isMirror` is false on each bucket.

- **Filed this run.** Items the Process Inbox, File Loose Tasks, and Meeting Follow-up phases created or moved in this session, while their source (the email, the meeting transcript, the captured note) is still in context. Build the list from this run's artifacts, not from memory, since the conversation may have been compacted: `.llm/gtd-refined-items.json`, `.llm/gtd/review/proposals/file-tasks.json`, and the meeting follow-ups under `.llm/gtd/review/meetings/`. Keep only items that are still open in the fresh exports above.

An item that lands in several categories appears once, under the first category that holds it in the order above.

## Keep only items Claude can help with

For each candidate, name the **concrete** help on offer, or drop it. Concrete means an action this session can take: draft the email or message, write or fix the code, research the question and summarize the answer, fill in the form's content, draft the doc or agenda, find the booking options. For code, resolve the working directory from `Metadata > 📂 Project Directories` instead of guessing a path.

Drop items that need the user's body or presence (a haircut, a phone call only they can make, a physical errand), items that are only a reminder to decide something, and items whose next step is waiting on someone else. "I can help you think about it" is not concrete help; when that is all there is, drop the item.

Read each surviving item's subtree (children, note, links) before proposing, per **Show the item, do not just name it** in `${CLAUDE_PLUGIN_ROOT}/skills/due-item-walk.md`. The offer has to rest on what the item actually says.

### Check whether the work already exists

Before offering to produce a deliverable (an outline, a draft, a doc, a list), look for it already existing. Check the item's subtree for children that hold it (a draft, an outline, a link to a doc, a saved partial result) and the last 14 days of the `📆 Calendar` journal for entries that record doing it. A user who opens with "did we start working on this" means the work exists somewhere, so search before answering.

When evidence is found, the offer changes:

- Quote the evidence in the context block: the child node or journal entry, with its workflowy.com link and date.
- Order **Already done** first in the options, since it is the likeliest answer.
- Add an **Update task text** option that rewrites the item's name to the step that remains (e.g. `Make the outline` becomes `Send the outline to @Alice for review`), leaving it open in place. Read it back after the rename.
- **Work on it now** offers the remaining step, never the part that is already done.

## Offer each item

Present the categories in order: due, then `1st` tier, then filed this run. Ask about one item per question through `AskUserQuestion`; one call may carry up to 4 questions, never two items in one question. Print the item's context block immediately before the call. Do **not** open with a question about how many items to cover or which category to start with. Go straight to the first item.

Each question names the item, its category and why it qualifies (`Due in 2 days`, `1st tier, Work`, `Filed today from the inbox`), and the specific help in one sentence. Options:

- **Work on it now** — the help, stated as the option label's description, e.g. `Draft the reply to @Alice's contract question`.
- **Not now** — leave the item exactly where it is.
- **Already done** — the user finished it outside the review. Complete it with the same per-source operation the due walk uses (a `complete` op from the row's `ops`, or `node complete --id <uuid>` for a ladder item), then read it back.
- **Update task text** — only when **Check whether the work already exists** found evidence; that section sets the option order.

## Work accepted items one at a time

When the user accepts, do the work before offering the next item. Work that needs its own project runs there: code goes in the item's project directory with that project's red/green TDD and precommit rules, not in this repository.

### Scope long drafts before writing them

Before drafting anything longer than a short reply (a doc, a proposal, an agenda, a multi-paragraph email), ask **one** scoping question through `AskUserQuestion` first. Offer 3 concrete framings drawn from the item's subtree, each naming the audience, the angle, and the rough length, e.g. `One-page summary for @Alice, decision-first` or `Bullet outline only, I'll write the prose`. Ask once, then draft against the chosen framing; do not stack further clarifying questions. Short replies and code skip this step.

### Keep partial drafts

Show the result (the draft, the diff, the research summary) and ask whether the item is now done. For a draft, never make the choice all-or-nothing. Options:

- **Done** — the draft is ready to use; complete the item.
- **Save as child** — keep the draft, or the parts worth keeping, as a child node under the item so the user can edit it later; the item stays open.
- **Revise** — the user says what to change; revise and ask again.
- **Discard** — drop the draft; the item stays open.

Only a confirmed done completes the item; a partial result stays open with a child node recording where the work stopped, so the next run resumes from it rather than rebuilding it.

The review's rules still hold here: never offer to pause or wrap up because the list is long, and an improvement idea goes to `.llm/gtd/review/mid-run-notes.md` rather than stopping the walk.

## Closing walk of launched agents

Before the run ends, read the ledger of cross-project agents launched by this review (see **Cross-project #llm-task launches** in `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/due.md`):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/agent-launches.mts pending
```

- For each launch in `ready`, read its report file and show it to the user as plain final text, never right before an `AskUserQuestion` (the dialog hides it). Then ask whether to advance the item's date with its staged `applyOp`; apply it only on yes.
- For each launch in `missing`, say the agent has not written a report (its pane may still be running or it exited early) and leave the item's date alone.
- Silent when the ledger holds no launches.

## Finish

Print one line per category, e.g. `✓ Due: 2 worked, 1 done, 3 not now · 1st tier: 1 worked · Filed: 0 offered`. Silent when no candidate survived the help filter.

Before printing that line, resolve every open loose end the run still holds: walk it with the user now (one `AskUserQuestion` per item) or file it as a Workflowy task with a link and context. The summary reports only what happened, never a "remember to" list. See the "No remember to loose ends in the final summary" section of `${CLAUDE_PLUGIN_ROOT}/commands/review/daily.md`.
