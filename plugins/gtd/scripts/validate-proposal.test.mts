// Run: node --test plugins/gtd/scripts/validate-proposal.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateProposal} from "./validate-proposal.mts";

const proposal = (overrides = {}) => (
{
	nodeId: "11111111-2222-3333-4444-555555555555",
	header: "Feb 9",
	before: "Ran 5k with Gary in the morning",
	after: "🏃 Ran 5k with @FrankWilson in the morning #exercise",
	changes: [
		{
			type: "people",
			icon: "👤",
			detail: "Gary → @FrankWilson",
		},
	],
	applyOps: [],
	...overrides,
});

const staged = (overrides = {}) => (
{
	task: "refine-journal",
	generatedAt: "2026-08-03T23:04:41-04:00",
	status: "ready",
	presentation: "Refine calendar journal",
	summary:
	{
		entriesReviewed: 31,
	},
	proposals: [proposal()],
	...overrides,
});

test("accepts a staged file matching the documented schema", () =>
{
	assert.deepStrictEqual(
		validateProposal(staged()),
		{
			valid: true,
			errors: [],
		},
	);
});

test("rejects a per-proposal moveToNodeId, which names a suggestion child and is not a move target", () =>
{
	const result = validateProposal(
		staged(
			{
				proposals: [
					proposal(
						{
							moveToNodeId: "99999999-8888-7777-6666-555555555555",
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: stages a second node id "moveToNodeId" — the 📍 Move to: suggestion child is not a destination parent; resolve destinations by path at apply time',
			],
		},
	);
});

test("rejects any other stray id field, whatever it is called", () =>
{
	const result = validateProposal(
		staged(
			{
				proposals: [
					proposal(
						{
							destinationParentId: "99999999-8888-7777-6666-555555555555",
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: stages a second node id "destinationParentId" — a proposal carries only nodeId; put every other id inside an applyOps command',
			],
		},
	);
});

test("allows inert non-id extension fields such as fingerprint", () =>
{
	assert.deepStrictEqual(
		validateProposal(
			staged(
				{
					proposals: [
						proposal(
							{
								fingerprint: "abc123",
								inbox: "Work",
							},
						),
					],
				},
			),
		),
		{
			valid: true,
			errors: [],
		},
	);
});

test("reports every offending proposal, not just the first", () =>
{
	const result = validateProposal(
		staged(
			{
				proposals: [
					proposal(
						{
							moveToNodeId: "a",
						},
					),
					proposal(),
					proposal(
						{
							refinementNodeId: "b",
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: stages a second node id "moveToNodeId" — the 📍 Move to: suggestion child is not a destination parent; resolve destinations by path at apply time',
				'proposals[2]: stages a second node id "refinementNodeId" — a proposal carries only nodeId; put every other id inside an applyOps command',
			],
		},
	);
});

test("requires a full uuid nodeId, since short ids 404 on writes", () =>
{
	const result = validateProposal(
		staged(
			{
				proposals: [
					proposal(
						{
							nodeId: "1493cca5a53d",
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: ['proposals[0]: nodeId "1493cca5a53d" is not a full uuid'],
		},
	);
});

test("requires --expect-name on every name update op", () =>
{
	const result = validateProposal(
		staged(
			{
				proposals: [
					proposal(
						{
							applyOps: [
								"./bin/run.js node update --id 11111111-2222-3333-4444-555555555555 --name 'new text'",
							],
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: ["proposals[0]: applyOps[0] updates --name without --expect-name"],
		},
	);
});

test("accepts a name update op carrying --expect-name", () =>
{
	const result = validateProposal(
		staged(
			{
				proposals: [
					proposal(
						{
							applyOps: [
								"./bin/run.js node update --id 11111111-2222-3333-4444-555555555555 --name 'new' --expect-name 'old'",
							],
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: true,
			errors: [],
		},
	);
});

test("accepts a node create op, which has no prior name to guard with --expect-name", () =>
{
	const result = validateProposal(
		staged(
			{
				task: "workout-guess",
				proposals: [
					proposal(
						{
							before: "",
							applyOps: [
								"./bin/run.js node create --parent-id 11111111-2222-3333-4444-555555555555 --name '💪 #ProgramX week 1, day 2, Legs #exercise' --position bottom",
							],
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: true,
			errors: [],
		},
	);
});

test("requires proposals[] to be empty unless status is ready", () =>
{
	const result = validateProposal(
		staged(
			{
				status: "empty",
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: ['status "empty" must carry an empty proposals[] array'],
		},
	);
});

test("accepts an empty status with no proposals", () =>
{
	assert.deepStrictEqual(
		validateProposal(
			staged(
				{
					status: "empty",
					proposals: [],
				},
			),
		),
		{
			valid: true,
			errors: [],
		},
	);
});

test("rejects an unknown status", () =>
{
	const result = validateProposal(
		staged(
			{
				status: "done",
				proposals: [],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: ['unknown status "done"'],
		},
	);
});

test("reports missing required top-level fields", () =>
{
	const result = validateProposal(
		{
			status: "empty",
			proposals: [],
		},
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: ['missing required field "task"', 'missing required field "generatedAt"'],
		},
	);
});

const emailCalendarProposal = (overrides = {}) => (
{
	header: "Sep 25",
	key: "alice-imap-uid-12345-sep25",
	altKeys: ["Book club dinner | 2026-09-25"],
	account: "alice",
	mailbox: "INBOX",
	messageUid: 12_345,
	messageId: "<CAB12345@mail.example.com>",
	actionLinks: ["https://example.com/rsvp/12345"],
	before: "Unread email offering registration for a dinner on Sep 25",
	after: "🍽️ Book club dinner — Fri Sep 25 2026",
	changes: [
		{
			type: "category",
			icon: "🏷️",
			detail: "New calendar event from unread email",
		},
	],
	...overrides,
});

const emailCalendarStaged = (overrides = {}) =>
	staged(
		{
			task: "email-calendar",
			presentation: "Scan email for events",
			proposals: [emailCalendarProposal()],
			...overrides,
		},
	);

test("accepts an email-calendar proposal carrying a ledger key", () =>
{
	assert.deepStrictEqual(
		validateProposal(emailCalendarStaged()),
		{
			valid: true,
			errors: [],
		},
	);
});

test("rejects an email-calendar proposal with no ledger key, since a null key suppresses nothing", () =>
{
	const {key: _key, ...withoutKey} = emailCalendarProposal();
	const result = validateProposal(
		emailCalendarStaged(
			{
				proposals: [withoutKey],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: email-calendar proposal has no ledger "key" — apply writes it to email-calendar-decisions.json, and a null key never suppresses a re-proposal',
			],
		},
	);
});

test("rejects an email-calendar proposal whose ledger key is null or blank", () =>
{
	const result = validateProposal(
		emailCalendarStaged(
			{
				proposals: [
					emailCalendarProposal(
						{
							key: null,
						},
					),
					emailCalendarProposal(
						{
							key: "   ",
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: email-calendar proposal has no ledger "key" — apply writes it to email-calendar-decisions.json, and a null key never suppresses a re-proposal',
				'proposals[1]: email-calendar proposal has no ledger "key" — apply writes it to email-calendar-decisions.json, and a null key never suppresses a re-proposal',
			],
		},
	);
});

test("names the sourceKey mismatch when prep staged the identity under the old field", () =>
{
	const {key: _key, ...withoutKey} = emailCalendarProposal();
	const result = validateProposal(
		emailCalendarStaged(
			{
				proposals: [
					{
						...withoutKey,
						sourceKey: "alice-imap-uid-12345-sep25",
					},
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: email-calendar proposal stages its ledger key as "sourceKey" — the ledger and apply read "key"; rename it',
			],
		},
	);
});

test("rejects an email-calendar proposal missing the source message, since Reject and delete trashes it without searching", () =>
{
	const {account: _account, mailbox: _mailbox, messageUid: _uid, ...withoutSource} = emailCalendarProposal();
	const result = validateProposal(
		emailCalendarStaged(
			{
				proposals: [withoutSource],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: email-calendar proposal is missing source message field(s) account, mailbox, messageUid — apply needs them to trash the email on "Reject and delete"',
			],
		},
	);
});

test("rejects an email-calendar proposal whose messageUid is not a positive integer", () =>
{
	const result = validateProposal(
		emailCalendarStaged(
			{
				proposals: [
					emailCalendarProposal(
						{
							messageUid: "12345",
						},
					),
					emailCalendarProposal(
						{
							messageUid: 0,
							account: " ",
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: email-calendar proposal is missing source message field(s) messageUid — apply needs them to trash the email on "Reject and delete"',
				'proposals[1]: email-calendar proposal is missing source message field(s) account, messageUid — apply needs them to trash the email on "Reject and delete"',
			],
		},
	);
});

test("rejects an email-calendar proposal missing messageId, since apply links the user to the source email", () =>
{
	const {messageId: _messageId, ...withoutMessageId} = emailCalendarProposal();
	const result = validateProposal(
		emailCalendarStaged(
			{
				proposals: [
					withoutMessageId,
					emailCalendarProposal(
						{
							messageId: " ",
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: email-calendar proposal is missing "messageId" (RFC 822 Message-ID) — apply builds the Gmail link to the source email from it',
				'proposals[1]: email-calendar proposal is missing "messageId" (RFC 822 Message-ID) — apply builds the Gmail link to the source email from it',
			],
		},
	);
});

test("rejects an email-calendar proposal whose actionLinks is not an array of http(s) URLs", () =>
{
	const {actionLinks: _actionLinks, ...withoutActionLinks} = emailCalendarProposal();
	const result = validateProposal(
		emailCalendarStaged(
			{
				proposals: [
					withoutActionLinks,
					emailCalendarProposal(
						{
							actionLinks: "https://example.com/rsvp",
						},
					),
					emailCalendarProposal(
						{
							actionLinks: ["mailto:rsvp@example.com"],
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: email-calendar proposal needs "actionLinks" as an array of http(s) URLs (empty when the email has none)',
				'proposals[1]: email-calendar proposal needs "actionLinks" as an array of http(s) URLs (empty when the email has none)',
				'proposals[2]: email-calendar proposal needs "actionLinks" as an array of http(s) URLs (empty when the email has none)',
			],
		},
	);
});

test("accepts an email-calendar proposal with no action links", () =>
{
	assert.deepStrictEqual(
		validateProposal(
			emailCalendarStaged(
				{
					proposals: [
						emailCalendarProposal(
							{
								actionLinks: [],
							},
						),
					],
				},
			),
		),
		{
			valid: true,
			errors: [],
		},
	);
});

test("still rejects messageId as a stray node id on other tasks", () =>
{
	const result = validateProposal(
		staged(
			{
				proposals: [
					proposal(
						{
							messageId: "<CAB12345@mail.example.com>",
						},
					),
				],
			},
		),
	);

	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: stages a second node id "messageId" — a proposal carries only nodeId; put every other id inside an applyOps command',
			],
		},
	);
});

test("does not require a ledger key on other tasks", () =>
{
	assert.deepStrictEqual(
		validateProposal(staged()),
		{
			valid: true,
			errors: [],
		},
	);
});

test("every name-update op documented in a staging command carries --expect-name", () =>
{
	const commands = ["../commands/review/daily/file-tasks.md"];
	const unguarded = commands.flatMap((relative) =>
		readFileSync(new URL(relative, import.meta.url), "utf8")
			.split("\n")
			.filter((line) => /node update --id \S+ --name /u.test(line) && !line.includes("--expect-name"))
			.map((line) => `${relative}: ${line.trim()}`),
	);

	assert.deepStrictEqual(unguarded, []);
});

test("rejects an email-calendar toolRequest that names the calendar as calendarName, since events_create takes calendar", () =>
{
	const result = validateProposal(
		emailCalendarStaged(
			{
				proposals: [
					emailCalendarProposal(
						{
							toolRequest:
							{
								tool: "events_create",
								arguments:
								{
									title: "Book club dinner",
									calendarName: "Home",
								},
							},
						},
					),
				],
			},
		),
	);
	assert.deepStrictEqual(
		result,
		{
			valid: false,
			errors: [
				'proposals[0]: email-calendar toolRequest stages "calendarName" — events_create takes "calendar"; rename it',
			],
		},
	);
});

test("accepts an email-calendar toolRequest that stages calendar", () =>
{
	const result = validateProposal(
		emailCalendarStaged(
			{
				proposals: [
					emailCalendarProposal(
						{
							toolRequest:
							{
								tool: "events_create",
								arguments:
								{
									title: "Book club dinner",
									calendar: "Home",
								},
							},
						},
					),
				],
			},
		),
	);
	assert.deepStrictEqual(
		result,
		{
			valid: true,
			errors: [],
		},
	);
});

test("accepts advisory Clef hints shaped {label, kind, score, source}", () =>
{
	const hints = [
		{
			label: "@FrankWilson",
			kind: "person",
			score: 0.93,
			source: "clef",
		},
	];

	assert.deepStrictEqual(
		validateProposal(
			staged(
				{
					proposals: [
						proposal(
							{
								hints,
							},
						),
					],
				},
			),
		),
		{
			valid: true,
			errors: [],
		},
	);
});

test("rejects malformed hints", () =>
{
	const hints = [
		{
			label: "FrankWilson",
			kind: "person",
			score: 0.93,
			source: "clef",
		},
		{
			label: "@FrankWilson",
			kind: "people",
			score: 1.5,
			source: "clef-flash-shortlist",
		},
	];

	assert.deepStrictEqual(
		validateProposal(
			staged(
				{
					proposals: [
						proposal(
							{
								hints,
							},
						),
						proposal(
							{
								hints: "x",
							},
						),
					],
				},
			),
		),
		{
			valid: false,
			errors: [
				'proposals[0]: hints[0] needs label "@Name" or "#tag", kind person|tag, score 0 to 1 and source clef-flash|clef',
				'proposals[0]: hints[1] needs label "@Name" or "#tag", kind person|tag, score 0 to 1 and source clef-flash|clef',
				"proposals[1]: hints must be an array",
			],
		},
	);
});
