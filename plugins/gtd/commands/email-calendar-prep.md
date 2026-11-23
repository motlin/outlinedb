---
name: email-calendar-prep
description: Stage calendar-event candidates from unread inbox email after decision-ledger and cross-calendar deduplication.
---

# Email Calendar Prep

Search unread inbox email for appointments that may belong on the calendar. This is autonomous prep: never prompt and never create events.

Load `.llm/gtd/review/email-calendar-decisions.json` first. Drop candidates whose stable key or alternate title-and-date key already appears; accepted and rejected decisions are both final.

Deduplicate survivors against every visible Google and Apple calendar. Use EventKit through iMCP for Apple calendars.

## Stop if a source is unavailable

Check all three sources — unread email, Google Calendar, Apple/iCloud Calendar via iMCP — **before** scanning. If any one of them is unavailable, **stop immediately**: stage the error below, write nothing else, and return. Do not scan email, do not deduplicate against the sources that do work, and do not stage proposals.

`iMCP.app` being in `ps` output does **not** mean iMCP works. The only thing that counts is whether the iMCP tools are registered in this session. A `helper-absent` result, a missing `mcp__*` tool, or a timeout all mean unavailable.

When this task runs as a daily-review prep controller, it runs in a **subagent**, and a subagent's tool registry is fixed at session startup. Relaunching `iMCP.app` does nothing, and neither does the user running `/mcp` mid-session — that reaches the main thread only. Recovery requires `/mcp` **and a session restart**; redispatching this task in the same session will fail identically. Say so in the staged error instead of asking for a retry that cannot work. The daily-review import barrier (`daily-import.md`) preflights this so the failure surfaces before fan-out.

Partial deduplication is worse than no run at all: an event already sitting on the unreachable calendar gets re-proposed every single review, and each rejection has to be re-entered by hand. A skipped task simply retries tomorrow. Never trade that away for a report that looks more actionable.

```json
{
	"task": "email-calendar",
	"generatedAt": "<now, ISO-8601 with offset>",
	"status": "error",
	"presentation": "Scan email for events",
	"error": "<source> unavailable: <what failed>. User must run /mcp and reconnect, then re-run this task.",
	"proposals": []
}
```

Write `.llm/gtd/review/proposals/email-calendar.json` using `${CLAUDE_PLUGIN_ROOT}/skills/review-proposal-staging.md`. Each proposal includes the ledger identity, event title, start and end, location, source context, target calendar recommendation, and exact creation operation or tool request. Stage `empty` when no undecided, unscheduled candidates remain.

## Ledger identity fields

The stable identity is staged as `key` and the alternates as `altKeys` — the exact field names the decisions ledger and `email-calendar-apply` read. Apply copies `.key` and `.altKeys` straight from the proposal into `.llm/gtd/review/email-calendar-decisions.json`, so any other name (such as `sourceKey`) produces a `"key": null` ledger row that suppresses nothing, and the same email is re-proposed every review with no visible error.

```json
{
	"header": "Sep 25",
	"key": "<account>-imap-uid-<uid>",
	"altKeys": ["<event title> | <yyyy-mm-dd>", "<subject> | <sender address>"],
	"account": "<account>",
	"mailbox": "INBOX",
	"messageUid": 12345,
	"uidValidity": 67890,
	"messageId": "<CAB12345@mail.example.com>",
	"actionLinks": ["https://example.com/rsvp/12345"]
}
```

## Calendar parameter

When a proposal stages a `toolRequest` for `events_create`, name the target calendar `calendar`, never `calendarName`. The tool ignores unknown parameters, so `calendarName` files the event on the default calendar with no error; the validator rejects it.

## Source message fields

Stage the source email's coordinates on every proposal so `email-calendar-apply` can trash it on **Reject and delete** without searching for it. `account` is the `<account>` segment of the IMAP MCP server that returned the message (`mcp__gmail-<account>-imap__*`), `mailbox` is the mailbox it was read from, and `messageUid` is its IMAP UID as an integer. Include `uidValidity` whenever the search result reports it, so a UID from a stale mailbox generation fails safely instead of hitting another message. Read the message without marking it seen.

## Source link fields

Stage the links apply shows in each question, so the user can open the email or sign up without an extra IMAP fetch:

- `messageId` — the source email's RFC 822 `Message-ID` header, verbatim including the angle brackets. Apply turns it into a Gmail `rfc822msgid:` search link.
- `actionLinks` — every sign-up, RSVP, registration, ticket, or form URL in the body, as absolute `http(s)` URLs in the order they appear. Unwrap tracking redirects when the real target is visible in the URL; drop unsubscribe, preference, social, and logo links. Stage `[]` when the email has none.

Derive `key` from the source message (`<account>-imap-uid-<uid>`, suffixed with the event date when one email yields several events). `altKeys` carry the title-and-date and subject-and-sender forms so a forwarded or re-sent copy still matches. After writing the file, run the validator; it rejects any `email-calendar` proposal whose `key` is missing, null, blank, or staged under another name, that lacks `account`, `mailbox`, an integer `messageUid`, or `messageId`, or whose `actionLinks` is not an array of `http(s)` URLs:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-proposal.mts .llm/gtd/review/proposals/email-calendar.json
```
