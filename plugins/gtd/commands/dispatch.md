---
name: dispatch
description: Send a fired reminder back to the Claude Code session that set it — find that session from the reminder's `dispatch-to:` line or by searching transcripts for the call that created it, match it to a live peer in ListAgents, and SendMessage the reminder text. Use when a reminder a session set for itself has fired, or the user asks which session a reminder belongs to.
arguments:
    - name: reminder
      description: The reminder title, plus its notes if available
      required: true
---

# Dispatch a Reminder

Sessions set reminders so they can come back to work later, like "widget 1.2.3 is 24h old — OK to merge the widget branches". When one fires, send it back to the session that set it, so that session picks the work up again with its context intact.

## Get the reminder's notes

If the user passed only a title, fetch the full reminder with `reminders_fetch` (iMCP) and match it by title. Its notes often explain why the reminder exists, and may hold a `dispatch-to:` line. If iMCP is down, continue with the title alone.

## Find the origin session

Run the finder with the exact title and the notes:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/find-reminder-origin.mts --text "<title>" --notes "<notes>"
```

It prints `{"dispatchTo": {name, ref} | null, "origins": [...]}`.

- **`dispatchTo` is set** — the session that created the reminder wrote its own address in the notes. Use that name and ref, and skip the search.
- **`origins` has entries** — each one is a main transcript with a tool call that created the reminder (iMCP `reminders_create`, or Bash `osascript` to Fantastical or Reminders), newest first, with its `cwd` and `sessionId`. Sessions that only saw the reminder, searched for it, or dispatched it earlier do not match.
- **Both are empty** — nothing created it with that exact text. Retry once with a distinctive substring of the title, since Fantastical may have reworded the sentence. If that also finds nothing, tell the user and stop.

The search reads every transcript, which takes several seconds. Run it once.

## Match a live peer

Call `ListAgents` and pick the row for the origin:

- With a `dispatch-to:` address, find the row with that name and ref. If the ref is gone, that session has ended: fall back to the name alone, then to the transcript search.
- With only a transcript, match the `cwd` basename to the row name. Session names are the project directory, sometimes with a short suffix (`widget`, `widget-3a`).
- Prefer a session that is **on this machine** and `idle` or `waiting`. Skip rows in `shell` state, because Claude isn't running there. Skip `offline` Remote Control rows.
- If more than one live row could be the origin, ask the user which one with `AskUserQuestion`, one option per candidate, showing each row's name, ref, state, and start time.
- If no live row matches, tell the user which project and transcript set the reminder, and that no session is running there to receive it.

## Send it

Send with the name **and** ref, because several sessions often share a name:

```text
SendMessage to: "<name> [<ref>]"
```

Make the first line `Reminder fired: <title>`, since that is the line the recipient's user sees in the preview. Put the notes on the following lines, then one line saying the condition in the reminder has now passed, so the session should do the work.

Report the result to the user. A successful send means the message reached that session's inbox, not that its Claude read it. If a `[Cross-session delivery notice]` arrives saying the session held or refused it, pass that on.

## Mark the reminder done

Once the send succeeds, ask whether to complete the reminder. iMCP cannot complete reminders; use the `osascript` snippet in `commands/review/daily/overview.md` → "Completing Apple Reminders".
