---
name: due-item-walk
description: The one-item-at-a-time walk protocol shared by every dated-item review — presentation rules, the context that must be shown before each question, banned openers, freeform handling, skip-streak cadence changes, and the read-before-write requirement. Load when running the Recurring Review's recurring or due segments, or any review that walks a precomputed ordered working set.
---

# Due-Item Walk

The daily review walks several ordered sets of dated items — recurring review items, one-shot due tasks from Workflowy, Things, and Reminders. They differ in what "done" writes back, but the presentation and the failure modes are identical. This is that shared protocol.

Every walk begins from a **precomputed ordered working set** produced by a script (`compute-overdue.mts`, `collect-due-items.mts`). The script has already done the date math, filtering, and ordering. Nothing is left to scope.

## Never ask how to scope the walk

**The volume is never grounds to ask.** Go straight to item 1. No matter how many items are overdue — 40+ is normal and expected — do NOT open with a meta-question offering to bulk-advance, handle "only the stale ones", filter by source, or skip a segment today. The user always walks every item one-by-one and has explicitly asked to stop being asked this.

This includes "summarize the count, then ask how to proceed." Printing a breakdown and then checking in is the same forbidden question wearing a summary. These openers are all banned, however phrased:

- "Walking N one-by-one is a lot / a long haul…"
- "Let me check how you want to handle the volume…"
- "…rather than firing N prompts at you."
- "Should I do the Workflowy ones first and the rest tomorrow?"
- any "that's a lot" / "this is tedious" editorializing about the count.

Printing a one-line count as context for item 1 is fine. Printing a count _and stopping_ is not.

The only correct first move after computing the working set is to present item 1.

## Present one item at a time

Use `AskUserQuestion`, never a plain-text batch. The user clears items quickly by tapping the first option. After recording an outcome and **dispatching its write in the background**, present the next item immediately — the write never blocks the next `AskUserQuestion`.

**Long walks switch to a decision page.** When the walk would ask more than about 8 questions, present all items on one decision page instead of `AskUserQuestion`. See "Choose the presentation surface" in `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`.

**One task per question.** Never put two unrelated tasks in one question, however similar they look — shared due date, shared source, or a shared theme does not make them one decision. One `AskUserQuestion` call may carry up to 4 questions, one per task, each with its own context and options. Only copies of the same task (the `duplicateCopies` survivor and its external copies) may share a question.

## Walk a recurring item's list entry by entry

When one recurring item's action spans a list — Things Today, an inbox, a folder — enumerate the entries and start with entry 1. The volume rule applies inside the item too: never replace the entry walk with one question offering to move, complete, or otherwise handle the whole list. Instruction children and completed entries are not candidates.

Show the parent title and `entry N/M`, then the current entry's real context immediately before its question. Ask for that entry's outcome, apply only that decision, and continue to the next entry. Preserve the applicable waiting, cross-source duplicate, recurring-counterpart, and hard-deadline rules; a parent review never authorizes a bulk write or bypasses an entry's protections.

Keep the parent in progress while walking its entries. Track decisions and pending writes per entry, and drain and verify those writes before asking for the parent's **Done**. Only after every entry has been handled and the user confirms the parent is done may its staged `applyOp` advance the recurring date once. A failed write, unresolved entry, or continued-work answer keeps the parent unfinished; record where to resume. An entry explicitly skipped for this review is a recorded decision, not completion of that entry. An empty list still needs the parent's Done confirmation; merely fetching or displaying it is not completion.

## Show the item, do not just name it

A title is not an item. "Inventory the drives" with 71 children is a different question from the same title with none, and nobody can decide about what they cannot see. Showing it is not extra credit — it is the work of asking. The row already carries the context, staged by the same script that staged the ops:

| Field                     | What it holds                                                         |
| ------------------------- | --------------------------------------------------------------------- |
| `url`                     | the item itself — a Workflowy node, a `things:///show?id=…` deep link |
| `links`                   | the external http(s) URLs in the item's own name and note             |
| `note`                    | the node's note, when it has one                                      |
| `modifiedAt`              | when the item last changed                                            |
| `childCount` / `children` | the direct children: title, note, own child count, url                |

Before asking about an item:

- **Open the external links, not the node.** `open` every URL in `links` — a PR, a doc, an article is the thing the item is about, and nothing in the terminal substitutes for it. Chain them into one backgrounded Bash call so nothing waits on the browser. `links` is already permalink-free: `extractLinks` drops every `workflowy.com` URL, so the whole list is safe to open unread.
- **Resolve a bare-URL title before presenting it.** When a row's title is (or is mostly) a URL with no other text, that title tells the user nothing — asking about it spends a whole turn getting back to what the item even is. Resolve it to a human title first: fetch the page title, or read the service's own metadata (a Spotify track, a YouTube video, an article headline). Present the resolved title with the link beside it, never the raw URL, and file the item under the resolved title too. An unresolved URL is an item you have not looked at, which this section already forbids.
- **Never open a workflowy.com permalink.** That SPA takes seconds to boot and interrupts whatever the user is doing, to show a node whose text the question already carries. This covers the row's own `url` and any permalink sitting in the item's text — every `@mention ↗` is one. For a row with no children and no note there is nothing there to see at all. Print the link inline as markdown instead and let the user click it if they want it.
- **For a big subtree, open the local mirror.** When a row has enough children that a printed list is unhelpful (roughly 8+, or any child with children of its own), open `https://workflowy.m4.notlin.com/node/<full-uuid>` — the project's own web app, which serves the same node in ~15ms instead of Workflowy's multi-second load. The route resolves a short id too, but the full uuid is what its in-app sibling navigation compares against, so prefer the uuid the row already carries. Fall back to printing the first 20 children inline if that host does not respond.
- **Fetch the rest of the subtree when one level is not enough.** `children` is depth 1. When any child has children of its own, pull the whole thing before asking:

    ```bash
    ./bin/run.js node get --id <full-uuid> --depth 4 --json
    ```

    This is the same fetch "Read the subtree before writing" already demands. Doing it now means it informs the question instead of only the write.

- **Read what you fetched.** A subtree often answers the question — prior entries say what "done" looks like here, and a conditional instruction whose trigger holds right now is part of handling the item.

Never present an item you have not looked at. An item asked blind gets skipped, and a skipped item comes back tomorrow costing the same question again.

## Print the context block immediately before the question

Terminal output scrolls. Context printed early — before a fetch, before an `open`, before a paragraph of narration — has scrolled off by the time `AskUserQuestion` renders, so it is context the user never saw. Gathering it and then burying it is the same as not gathering it.

The context block is therefore the **last thing** emitted before the `AskUserQuestion` call, with nothing in between: no tool call, no "let me check…", no recap of what you just did. Gather everything first, then print, then ask, as one uninterrupted move.

The block, read straight from the working set and never recomputed by hand:

```text
**⬆️ Frequently Important** — item 3/8

**Inventory the drives** — due 2026-02-09, overdue by 12 days
https://workflowy.com/#/aabb1122 · last changed 2026-06-20 · opened in Workflowy
Note: started from [the spec](https://example.com/spec)
3 children:
    - Drive A (2 children)
    - Drive B — spare
    - Drive C
Skipped 3 runs in a row since 2026-08-11.
```

- Render embedded URLs as clickable markdown. Parse `<a href="...">text</a>` in the node name and emit `[text](url)`; strip other HTML for display.
- List the children. Cap the list around 20 and close with `… and 51 more — open in Workflowy`, so a huge subtree does not push the item's own heading off screen.
- **Completed children are already gone.** `nodeContext()` filters them out and `childCount` is the open count, so read the list as-is. Never read a finished child aloud as a live candidate, and never re-add one you spot in a raw `node get` — a recurring item that mirrors a bucket is mostly finished work, and asking about it wastes the question.
- Say what you opened, so the user knows which tab or app belongs to this question.
- Repeat the deciding facts — overdue math, child count, skip streak — in the `AskUserQuestion` body. The block is terminal output; only the question text survives into the next session.

## A mirror is a view of a task that lives elsewhere

Workflowy mirrors put one task in two trees at once. A node whose `mirror.isMirror` is true is a **reflection**: the original — `mirror.originalNodeId` — holds the text, the date, and the real filing, and the reflection holds nothing of its own. So a mirror is never a misfiled item, and its appearance in this tree is never evidence that something was filed wrong.

Detect it with the `mirror` field. The recurring segment's tree fetch already asks for it; add it to the `--fields` list of any fetch that does not, because an unrequested field comes back absent and absent reads exactly like "not a mirror". When a row is a mirror:

- **Present it read-only, or skip it.** Name it as a mirror of a task that lives elsewhere and move on. The walk that owns the original is the one that handles it, and handling it in both places writes twice.
- **Write nothing — not to the mirror, not to the original.** No `<time>` stripped or advanced, no `node move`, no completion. The original is correctly filed where it is; you are only looking at a copy of it.
- **Never file anything under a mirror.** `node move --parent-id <mirror-uuid>` parents the node **under the mirror**, not under the node the mirror reflects, which buries a real task inside the reflecting tree. Resolve destinations from the real root and confirm `mirror.isMirror` is false on whatever you are about to write into.

"This belongs somewhere else" is never grounds to re-file a mirror. Changing where a mirrored task lives means walking the original in the set that owns it.

## Freeform: note, continued work, or retire

A freeform answer is a **note**, **continued work**, or **retire**, and they end very differently:

- **Note** — a remark to record and move past ("went well", "the vendor replied"). File it as a child node, **dispatched in the background** as a separate job from the outcome write, treat the item as handled, and continue.
- **Continued work** — an instruction, a correction, new information, or a request to keep going on this item ("I plugged in another drive, go inventory it", "that is wrong, redo it"). Stay on the item and do the work. Do **not** write the outcome and do **not** present the next item.
- **Retire** — an explicit statement that a recurring item should no longer exist. Follow the recurring walk's retire operation, do **not** advance its date, count it as retired, and continue. This class does not apply to one-shot due items; use their **Drop** outcome instead.

An explicit external handoff ("I submitted the claim; now we wait for their response") selects **Waiting on someone else** below, not Note or Done.

When continued work is in progress, only an explicit outcome from the user ends the item. Silence, a completed sub-task, or your own sense that the work looks finished never earns the write. When the answer is genuinely ambiguous, treat it as continued work — resuming a finished item is cheap; recording completion on unfinished work hides it for a whole interval.

## Help me do it now

Some items are a procedure, not a reminder: the notes or children list steps this session can carry out — verify a charge on a statement, research a policy, find a request form, draft a message, or type it into a web form in the browser. Handing the user a script of those steps leaves them to do work Claude could have done. When the subtree you already read describes steps like these, offer **Help me do it now** right after the row's first option, and describe the concrete help in the option's description, e.g. `Check the statement for the fee, then draft the waiver request`.

Apply the concrete-help test from `${CLAUDE_PLUGIN_ROOT}/commands/review/daily/work-together.md` under **Keep only items Claude can help with**. Skip the option when the steps need the user's body or presence, when the item is only a decision, or when the next step is waiting on someone else. "I can help you think about it" does not count.

On pick, the item becomes **Continued work** (see above): stay on it and perform the steps yourself — read the account page, run the search, fill in the draft — and report what each step found. Do **not** reply with instructions for the user to follow. Two guards apply:

- **Confirm before anything leaves.** Show the drafted message or filled form and get an explicit yes through `AskUserQuestion` before sending, submitting, paying, or posting. Drafting and typing into a field are fine; the final click is the user's call.
- **End only on an explicit outcome.** When the work stops, ask for the row's ordinary outcome. A submitted request is **Waiting on someone else**, not Done. Unfinished work keeps the item open with a child node recording where it stopped, and the draft saved as a child when one exists, so the next run resumes from that point.

## Read the subtree before writing

Before writing into any item, fetch and read its full subtree — the same fetch the context block already required, so it is usually still on screen:

```bash
./bin/run.js node get --id <full-uuid> --depth 4 --json
```

Then conform to what is already there:

- **Match the existing format.** If sibling entries share a shape, the new entry uses that shape rather than one you invent.
- **Match the existing placement.** A new entry belongs alongside its siblings — not appended at the end of the item, and not nested under an unrelated child.
- **Keep instruction children separate from data children.** Nodes that tell you what to do are not entries; never interleave new data into them.
- **Execute conditional instructions whose trigger currently holds.** When the subtree says "if X is present, do Y" and X is present right now, do Y as part of handling the item.

Showing an item's children to the user is not reading them. Skipping this step produces writes that look plausible and are structurally wrong.

## Recompute when the date rolls over

A long review crosses midnight, and every staged `applyOp` baked in the local date at the moment prep ran. Running a stale op verbatim writes yesterday's arithmetic — the wrong next date, the wrong weekday label.

Before each segment, compare the prep date staged in `overdue.json` against the current local date. When they differ, re-run `${CLAUDE_PLUGIN_ROOT}/scripts/compute-overdue.mts --today YYYY-MM-DD --run-started <iso>` with today's date and the ISO timestamp this review run began (`.llm/gtd/review/run-started.txt`, written at the top of `/gtd:review:daily`), and walk the fresh rows. Pass `--run-started` on every recompute: it drops rows whose skip-log entry has any outcome at or after the run start, so items already answered this run are not asked again after the rollover. This is the same guard `birthdays-prep.md` / `birthdays-apply.md` apply through `generatedFor`.

## Run staged ops verbatim

Each row in the working set carries its outcome commands already built and shell-escaped. Run them **verbatim**. Do not rebuild a `<time>` element, an `osascript` call, or a `node update` by hand — the script is the source of truth for date math and escaping, and hand-built writes are where wrong weekdays and quoting bugs come from.

Dispatch every write as a background Bash job and follow **Background Dispatch, Verify, and Drain** in `${CLAUDE_PLUGIN_ROOT}/skills/review-date-updates.md`: track each job, reap finished jobs every ~5 items, surface failures inline by item name, and present the next item without waiting.

## Check whether recurring work already covers a due item

Before offering a Workflowy asap tier for a chore, maintenance task, or medication row, inspect `recurringCounterparts` from the full staged review tree. Include future dates, not only the overdue recurring working set. Show each candidate's title, full path, link, and next date in the question body. The daily due command defines the lookup and ordering; a missing lookup must be completed before the tier question.

Promote **Delete this copy — the recurring item covers it** when a candidate exists, followed by **Make it recurring**, above the asap outcome. Matching titles alone never authorize deletion: the user must confirm the recurring item covers this occurrence. Preserve hard-deadline protections and resolve multiple matches explicitly. Existing cross-source duplicate handling remains first and never implicitly deletes its Workflowy survivor.

On **Delete this copy — the recurring item covers it**, read the due copy's subtree and the chosen recurring counterpart before writing. Confirm any unique notes or children are covered before deletion, and confirm deletion explicitly when `childCount > 0`. Run only the approved due copy's `ops.drop`; leave the recurring node, date, placement, and children unchanged. Reminders deletion joins the existing batch. Verify the due copy is deleted (Things canceled) and the recurring counterpart remains live and unchanged before recording `drop` for the due copy. Never record completion or advance the recurring date for this answer.

## Make it recurring

Some one-shot due items are not one-shots at all — they are habits filed in the wrong place. When the user says an item belongs in the recurring review, that is this outcome, not a reschedule.

Check existing counterparts first. If one already covers the work, offer deletion of this copy instead of creating a second recurring task; keep both only on an explicit user decision. When a new recurring task is needed, ask which `Personal > 🔄 Review` section receives it (⬆️ Frequently Important, Weekly, Monthly, …), move the node under that section, and write the section's cadence `<time>` per `${CLAUDE_PLUGIN_ROOT}/skills/review-date-updates.md`. Record the outcome as `reschedule` in the skip log so the streak resets.

Non-Workflowy rows take the same shape **Preserve priority in the asap ladder** already uses for Reminders: create the Workflowy recurring node under the chosen section, then delete the Things task or Apple Reminder, and verify both sides before treating the outcome as handled.

## Edit a Things repeat rule

Things' AppleScript dictionary does not expose repeat rules, so a cadence change on a repeating Things to-do goes through the UI:

- Select the to-do with `open "things:///show?id=<id>"`, then wait for Things to come forward. The **Repeat** submenu only appears under **Items** while a to-do is selected.
- Open the rule sheet with `tell application "System Events" to tell process "Things3" to click menu item "Edit Rule…" of menu 1 of menu item "Repeat" of menu "Items" of menu bar 1`. The menu item name ends in a real ellipsis (`…`), not three periods.
- The sheet holds pop-up buttons for the frequency (weekly, monthly, ...), the weekday, and the next date. Set each with `click` on the pop-up, then `click` the menu item inside it. Read back each pop-up's `value` before confirming.
- Click **OK** to save, or **Cancel** to back out of a sheet this walk opened.
- Verify by reopening **Edit Rule…** and reading the pop-up values, or by checking that the to-do's activation date moved to the new next date.

## Drop the non-Workflowy copy, leave Workflowy live

For a due row with `duplicateCopies`, show the Workflowy survivor and each external copy in one question naming both stores (or all three), with **Drop the non-Workflowy copy, leave Workflowy live** first. Matching normalized titles identify candidates; the user's choice confirms which copies represent the same task. Keep ordinary tasks' priority and deadline rules unchanged.

This outcome is `dropDuplicate`. Run only the approved external copies' staged `ops.drop`: Things is canceled, and Reminders is deleted through the segment's batched write. Preserve the Workflowy node, its completion state, date, and placement exactly. This outcome neither completes nor reschedules it and never runs its `ops.complete`, `ops.reschedule`, or `ops.drop`.

Verify Things reports `canceled` or `reminders_fetch` no longer lists the approved reminder, and read back the survivor to confirm it remains live and unchanged. Only after verification, record `dropDuplicate` against **both** the surviving `workflowy:<id>` key and each successfully removed external copy's key. This resets the survivor's skip streak while leaving its task live for the next run. Pending or failed deletion is not a handled survivor: surface the failure and do not write a successful record for it. Do not ask about the survivor again in this run after successful removal.

## Waiting on someone else

Offer **Waiting on someone else** on every one-shot due row, including Workflowy, Things, and Reminders. Use it when the user has finished their part but the outcome depends on an external party: a submitted claim, a filed request, or a sent question. Say plainly that handing work to an external party is **Waiting on someone else**, not **Done**; the follow-up stays incomplete.

Ask when to check back. If the item or its fetched subtree records a typical turnaround, show that evidence and recommend that horizon; otherwise ask for the horizon without inventing a default. Resolve the chosen date with the date helpers in `${CLAUDE_PLUGIN_ROOT}/scripts/collect-due-items.mts`, and build its `<time>` with `buildTimeElement(iso)` from that module. Replace the previous due `<time>` with the check-back stamp appended to the title, preserving the rest of the title, notes, and children. Preserve any genuine external deadline in the item's context so the check-back date cannot erase that obligation.

Resolve the matching root's direct **📤 Delegate** child from the staged `root-<work|personal>.json`; it is a sibling of `✅ Tasks`, not a bucket inside it. Confirm the destination is a real node, not a mirror. Workflowy rows keep their `rootKey`; external rows default to Personal, offering Work when the item concerns work. If the destination is absent or ambiguous, resolve it before writing rather than guessing an ID or creating a second Delegate node.

- **Workflowy** — move the existing incomplete node under that Delegate UUID and update its title with the check-back stamp. Keep its subtree intact; do not run `ops.complete` or create a second task.
- **Things and Reminders** — create the incomplete follow-up under that Delegate UUID, preserving the source's notes and other task context and appending the check-back stamp. Verify the new node and its context before removing the external copy with its staged `ops.drop`. Things is canceled; Reminders deletion joins the existing batch. Never complete the source as though the external outcome had arrived, and never remove it if creation or verification fails.

Read back the Workflowy node to verify its parent, check-back date, incomplete state, and preserved context. For an external source, also verify its removal (Things `canceled`, or absence from `reminders_fetch`); pending batch deletion is not a successful migration. Only then record the distinct outcome `waiting` under the original row's skip-log key, resetting its skip streak, and count it separately from Done. On failure, report the item and leave it unhandled. `overview.md` already surfaces **📤 Delegate** every morning; do not create a second reminder or alarm for this outcome.

## Move to Workflowy

A Things task or Apple Reminder that reaches a due walk with a real date is usually a task in the wrong database, not a task with the wrong date. The goal is a single database, so every one-shot due-item walk offers **Move to Workflowy** on Things and Reminders rows, and places it **first** on Reminders rows — a dated reminder has nothing the `⏰ Tasks (due dates)` bucket does not do better, and it is the answer the user gives almost every time. Workflowy rows never carry it; they are already home.

This is a handled outcome, not a reschedule and not **Clear the date**: the date stays, only the store changes. Record `moveToWorkflowy` so the skip streak resets.

The shape is the create-then-close pairing the file-tasks Things sweeps use:

- **Create first.** File the task under the matching root's `⏰ Tasks (due dates)` bucket, carrying the row's `due` across as a script-built `<time>` element, never a hand-built one.
- **Close second, never before.** Complete the Things task or delete the reminder only after the create has returned. For Things, chain the pair with `&&` in one background job so a failed create cannot destroy the task. For Reminders, the deletion joins the batched Reminders write instead — one write per item freezes the app — so the create runs now and the delete lands with the batch.
- **Verify both sides.** The new node is in the bucket, and the original is gone: `status of to do id` reads `completed` in Things, and `reminders_fetch` no longer lists the reminder. An exit code proves neither.

The segment's own command file names the exact ops and the bucket lookup.

## Preserve priority in the asap ladder

On this user's tasks, due dates often mark **HIGH PRIORITY**. A passed date is evidence that the task matters; without external-deadline evidence, it does not establish lateness. After the recurring-counterpart check, for every ordinary one-shot Workflowy `⏰` row in that situation, offer **Move to asap ladder** immediately after **Done**, above **Reschedule** or a longer horizon, even with a skip streak. Preserve the priority when removing the date. Things and Reminders retain the **Clear the date** label when their date is no longer needed. Record `clearDate` for this handled outcome so the skip streak resets. Keep dates backed by external deadlines unless the user chooses otherwise; **Move to Workflowy** preserves a date while changing the store.

The destination depends on the source:

- **Workflowy** moves into a chosen tier of that root's `📌 Tasks (asap)` ladder with its `<time>` removed.
- **Things 3** stays in Things with its due date cleared. Do not ask for a Workflowy tier because the task is not moving to Workflowy.
- **Apple Reminders** cannot clear a due date. Create the task in a chosen Workflowy asap tier, then delete the reminder and verify both sides before treating the outcome as handled.

When the destination is a Workflowy asap ladder, load `${CLAUDE_PLUGIN_ROOT}/skills/asap-tiers.md`, show the current occupants and capacity of each tier, and ask one follow-up tier question offering **1st / 2nd / 3rd / 4th**. Recommend `2nd` as the mid-high default, comparing the task with the current occupants. The prior due date supplies a strong priority signal, so the generic weak-signal bottom default in `asap-tiers.md` does not apply here. Never default to the bottom tier; use it only when the user explicitly deprioritizes the task. If a listed tier is currently the bottom, identify it as such and require that explicit choice before using it. Use `readLadder`, `tierCapacity`, and `planInsertion`. Filing only inserts the task; it never moves any other item, even when the chosen tier is full, so never warn that something will be bumped or ask a confirming question about a full tier. Never silently choose a tier or hand-calculate capacity.

## Set a reminder

Every walk offers **Set a reminder** for an item the user will handle later today but will forget without an alarm — "I need a due task for this or I will forget" is this answer, not a skip. It is one answer, not two: create and verify the alarm, then apply the row's ordinary handled outcome — the user never has to say "remind me" and then "done" as separate turns.

Ask for a time with one follow-up question — **In an hour**, **This afternoon (3pm)**, **This evening (7pm)**, or **Other** for a typed time. Convert a relative choice to a clock time in the shell (`date -v+1H '+%-I:%M%p'`) so the sentence Fantastical parses carries an explicit time, never a relative phrase that can land on the wrong day.

Create the alarm through Fantastical, the same snippet `commands/review/daily/overview.md` documents. `reminders_create` drops the due date, so an iMCP-created reminder never fires:

```bash
osascript -e 'tell application "Fantastical" to parse sentence "reminder <title> today at 3:00pm" with add immediately'
```

The `reminder` keyword is what makes Fantastical file a reminder instead of a calendar event. Use the item's plain title — strip HTML, the `<time>` element, and trailing `#tags` — and shorten it to a noun phrase when it contains words the parser would read as dates or times ("tomorrow", "Monday", "at 5").

**Verify with `reminders_fetch` before doing anything else.** Fantastical exits 0 on failure, so the exit code proves nothing. Query `completed:false` by the title and confirm the reminder exists with a `scheduledTime` matching the requested time. The reminder often lands a few seconds after `osascript` returns, so a miss on the first query is not yet a failure: keep polling `reminders_fetch` for about 15 seconds (a check every few seconds) before retrying, or the retry creates a duplicate. When it is still missing after that window, retry once with the time first (`reminder at 3:00pm today <title>`) and poll the same way. After any retry, fetch again and, if both attempts landed, delete the extra through `osascript` against Reminders (iMCP has no delete) so exactly one reminder remains. When it is still missing, say so, do **not** apply the outcome below, and treat the item as skipped so it resurfaces tomorrow — an advanced item with no alarm is the exact silent loss the user asked to prevent.

Once the alarm is verified, apply the row's normal handled outcome and record it:

- **Recurring item** — the reminder covers today's occurrence, so run the row's staged `applyOp` verbatim, exactly as **Done** would, and record `remind`.
- **One-shot due item** — the task stays until it is actually done, so reschedule it to today with `resolveTimeframe` + `applyReschedule` from `collect-due-items.mts` (a no-op rewrite for a row already dated today, and an honest date for an overdue one), and record `remind`. Tomorrow's walk asks about it again if it never got done, which is correct. An Apple Reminders row already is a reminder, so do not create a second one through Fantastical: set the requested time on the existing reminder inside the batched Reminders write the segment's command file describes, and verify it the same way.

`remind` is a handled outcome: it resets the skip streak like any other non-skip record.

## Look up an appointment in email

When an item or the overview needs an appointment's details (a home-service visit, a delivery, a repair window), find the confirmation email before asking the user. Searching message bodies for the trade word ("plumber", "HVAC") misses most of these: vendors send them from scheduling platforms whose subjects and bodies never name the trade.

**Search every configured mail account, never a fixed pair.** Discover the accounts from the available tools: each `mcp__gmail-<account>-imap__search_messages` server is one account. Run the searches below against every one of them, in parallel, and merge the results. An account whose server is absent or fails is reported in one line, not silently skipped.

For each account, search the last few weeks (`since`) in the inbox and All Mail (`mailboxes: ["INBOX", "[Gmail]/All Mail"]`), so an archived confirmation still turns up:

- **By subject word** — one `subject` search per word: `Confirmed`, `Appointment`, `Service Details`, `Service Window`, `Scheduled`, `Reminder`.
- **By sender** — `from` with the vendor's name or domain when the item, its children, or an earlier email names one.
- **By body keyword** — `body` with the trade word and the vendor name, as a last net rather than the first.

**Check the calendar's email-created events for that day.** Gmail adds events it detects in confirmation emails to Google Calendar, often as a one-hour block that hides a longer service window. List that day's events with `mcp__claude_ai_Google_Calendar__list_events` including `eventType: ["FROM_GMAIL"]`. Such an event comes from a source email: find and open that email and read the real arrival window from it, never from the event's start and end.

Open each candidate with `get_message` (`markSeen: false`) and report the window, the vendor, and the account it came from. Only when every account and the calendar come up empty, say what you searched and ask the user to paste the email.

## Say it in plain words

Everything the walk reports is read by a person, not a maintainer. Describe what happened in ordinary language — "Reminders stopped accepting writes", "the app froze", "the sync never finished". Never use insider terms for failure states: **wedged**, _hung_, _pegged_, _thrashing_, _deadlocked_. If a word would not appear in a note to a friend, it does not belong in a status line.

## Skip leaves everything unchanged

On skip, write nothing. The item keeps its date and resurfaces on the next run. This is the correct outcome for anything the user did not actually handle — a skipped item the user sees again beats a silently advanced one they never see.

## Record every outcome to the skip log

Skipping writes nothing to the item, but it does write to the walk's own memory. After each item, dispatch one record command in the background alongside the outcome write:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/compute-overdue.mts --record <key> --outcome <skip|done|lengthen|retire|reschedule|moveToWorkflowy|clearDate|remind|waiting|dropDuplicate|drop>
```

The key is the recurring row's `id`, or `<source>:<id>` for a one-shot due row (`things:ABC123`, `workflowy:<uuid>`). The log is append-only JSONL at `.llm/gtd/review/skip-log.jsonl`, so concurrent background jobs cannot clobber each other, and repeats within one day collapse instead of inflating a streak.

Record **every** outcome, not just skips — a streak only resets when a handled outcome lands. Skipping the record command for "done" leaves the item looking abandoned on the next run.

## A skip streak means the cadence is wrong, not that the item is dead

Every row carries `skipStreak` (consecutive runs that ended in skip) and `skippedSince`. When `skipStreak >= 2`:

- **Say it in the question body**, read from the row: `Skipped 3 runs in a row since 2026-08-11.` The annotation must live in the question — a streak you only remember from earlier in the conversation is gone by the next session.
- **Promote a cadence change as an explicit outcome**, placed above the ordinary outcomes. Repeatedly skipping an item almost always means it comes back too often, not that it should stop existing. A recurring item lengthens its interval; a one-shot task with a movable external deadline pushes out to a longer horizon. For an ordinary one-shot Workflowy due row without external-deadline evidence, keep **Move to asap ladder** immediately after **Done** and preserve its priority instead. The segment's own command file names the exact op.
- **Keep retire and drop available, but never as the promoted option.** They are for an item the user says is genuinely dead, not the default reading of a skip streak.

A streak is not a reason to skip the item or to editorialize about the backlog. Present the item, offer the cadence change, and move on.

## Finish

Drain all outstanding background writes, then print a one-line summary (`✓ 12 dates advanced, 2 cadences lengthened`), or list any failed items by name instead of reporting success. Also drain before any step that runs `cache import-api` / `just daily` — an import can clobber items whose API write has not yet landed.
