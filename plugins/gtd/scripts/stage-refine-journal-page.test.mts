// Run: node --test plugins/gtd/scripts/stage-refine-journal-page.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readJsonFile} from "./json.mts";
import {buildRefineJournalPage, resolveRefineJournalAnswers} from "./stage-refine-journal-page.mts";

const script = new URL("stage-refine-journal-page.mts", import.meta.url).pathname;

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const ID_D = "44444444-4444-4444-8444-444444444444";
const ID_E = "55555555-5555-4555-8555-555555555555";

const plain =
{
	nodeId: ID_A,
	scope: "recent",
	header: "Nov 4",
	before: "Ran with Bob ",
	after: "🏃 Ran with @Bob",
	changes: [
		{
			type: "people",
			icon: "👤",
			detail: "Bob → @Bob",
		},
		{
			type: "emoji",
			icon: "😀",
			detail: "add 🏃 prefix",
		},
	],
	applyOps: [
		"./bin/run.js node update --id 11111111-1111-4111-8111-111111111111 --name '🏃 Ran with @Bob' --expect-name 'Ran with Bob '",
	],
};

const emojiPicker =
{
	nodeId: ID_B,
	scope: "recent",
	header: "Nov 5",
	before: "Alice's party",
	after: "🎉 Alice's party",
	changes: [
		{
			type: "ambiguous",
			icon: "⚠️",
			detail: "no tag-based emoji",
		},
	],
	ambiguity:
	{
		prompt: "Pick a leading emoji",
		options: ["🎉 party", "🎂 birthday", "🏠 at home", "🧑‍🤝‍🧑 friends"],
	},
	applyOps: [
		"./bin/run.js node update --id 22222222-2222-4222-8222-222222222222 --name '🎉 Alice'\"'\"'s party' --expect-name 'Alice'\"'\"'s party'",
	],
};

const peopleChoice =
{
	nodeId: ID_C,
	scope: "recent",
	header: "Nov 5",
	before: "Lunch with Carol",
	after: "🍽️ Lunch with @CarolSmith",
	changes: [
		{
			type: "people",
			icon: "👤",
			detail: "Carol → @CarolSmith",
		},
	],
	ambiguity:
	{
		prompt: "Which Carol?",
		options: [
			{
				label: "@CarolSmith",
				applyOps: [
					"./bin/run.js node update --id 33333333-3333-4333-8333-333333333333 --name '🍽️ Lunch with @CarolSmith' --expect-name 'Lunch with Carol'",
				],
			},
			{
				label: "@CarolJones",
				description: "The neighbor",
				after: "🍽️ Lunch with @CarolJones",
			},
			{
				label: "Skip tagging",
				applyOps: [],
			},
		],
	},
};

const wording =
{
	nodeId: ID_D,
	scope: "recent",
	header: "Nov 6",
	before: "Send it off.",
	after: "📬 Sent it off.",
	changes: [
		{
			type: "typo",
			icon: "✏️",
			detail: "send → sent",
		},
	],
	ambiguity:
	{
		prompt: "Change send to sent?",
		options: ["Change to sent", "Change to mailed"],
	},
	applyOps: [
		"./bin/run.js node update --id 44444444-4444-4444-8444-444444444444 --name '📬 Sent it off.' --expect-name 'Send it off.'",
	],
};

const archived =
{
	...plain,
	nodeId: ID_E,
	scope: "archive",
	header: "Jan 2",
};

const proposals = [plain, emojiPicker, peopleChoice, wording, archived];

const accept =
{
	value: "accept",
	label: "Accept",
	description: "Apply the proposed text",
};
const keep =
{
	value: "reject",
	label: "Keep as written",
	description: "Reject the rewrite; it never comes back",
};

const recentPage =
{
	slug: "refine-journal-2026-11-15",
	title: "Refine calendar journal",
	intro: "4 proposed rewrites of journal entries. Pick an option per card; add a note to edit the proposed text. Keep as written records the rejection so it never comes back.",
	groups: [
		{
			heading: "Nov 4",
			items: [
				{
					id: "p0",
					title: "Nov 4: emoji, people",
					diff:
					{
						before: "Ran with Bob ",
						after: "🏃 Ran with @Bob",
					},
					body: ["👤 Bob → @Bob", "😀 add 🏃 prefix"],
					links: [],
					options: [accept, keep],
					default: "accept",
				},
			],
		},
		{
			heading: "Nov 5",
			items: [
				{
					id: "p1",
					title: "Nov 5: pick one",
					diff:
					{
						before: "Alice's party",
						after: "🎉 Alice's party",
					},
					body: ["⚠️ no tag-based emoji", "⚠️ Pick a leading emoji"],
					links: [],
					options: [
						{
							value: "opt0",
							label: "🎉 party",
							description: "As in the proposed After",
						},
						{
							value: "opt1",
							label: "🎂 birthday",
							description: "Swap in this emoji",
						},
						{
							value: "opt2",
							label: "🏠 at home",
							description: "Swap in this emoji",
						},
						{
							value: "opt3",
							label: "🧑‍🤝‍🧑 friends",
							description: "Swap in this emoji",
						},
						keep,
					],
					default: "opt0",
				},
				{
					id: "p2",
					title: "Nov 5: people",
					diff:
					{
						before: "Lunch with Carol",
						after: "🍽️ Lunch with @CarolSmith",
					},
					body: ["👤 Carol → @CarolSmith", "⚠️ Which Carol?"],
					links: [],
					options: [
						{
							value: "opt0",
							label: "@CarolSmith",
							description: "As in the proposed After",
						},
						{
							value: "opt1",
							label: "@CarolJones",
							description: "The neighbor",
						},
						{
							value: "opt2",
							label: "Skip tagging",
							description: "Keep as written; it never comes back",
						},
					],
					default: "opt0",
				},
			],
		},
		{
			heading: "Nov 6",
			items: [
				{
					id: "p3",
					title: "Nov 6: typo",
					diff:
					{
						before: "Send it off.",
						after: "📬 Sent it off.",
					},
					body: ["✏️ send → sent", "⚠️ Change send to sent?"],
					links: [],
					options: [
						{
							value: "opt0",
							label: "Change to sent",
							description: "As in the proposed After",
						},
						{
							value: "opt1",
							label: "Change to mailed",
							description: "Use this instead; Claude confirms the exact text",
						},
						keep,
					],
					default: "opt0",
				},
			],
		},
	],
};

test("buildRefineJournalPage stages one diff card per proposal in scope, grouped by entry date, with short titles", () =>
{
	assert.deepStrictEqual(
		buildRefineJournalPage(
			{
				proposals,
				scope: "recent",
				today: "2026-11-15",
			},
		),
		recentPage,
	);
});

test("buildRefineJournalPage stages the archive block on its own slug, keeping ids from the full proposal list", () =>
{
	assert.deepStrictEqual(
		buildRefineJournalPage(
			{
				proposals,
				scope: "archive",
				today: "2026-11-15",
				archiveMonth: "2026-01",
			},
		),
		{
			slug: "refine-journal-archive-2026-11-15",
			title: "Refine calendar journal (archive 2026-01)",
			intro: "1 proposed rewrite of journal entries. Pick an option per card; add a note to edit the proposed text. Keep as written records the rejection so it never comes back.",
			groups: [
				{
					heading: "Jan 2",
					items: [
						{
							...recentPage.groups[0]?.items[0],
							id: "p4",
							title: "Jan 2: emoji, people",
						},
					],
				},
			],
		},
	);
});

test("buildRefineJournalPage treats proposals without a scope as recent", () =>
{
	const {scope: _scope, ...unscoped} = plain;
	assert.deepStrictEqual(
		buildRefineJournalPage(
			{
				proposals: [unscoped],
				scope: "recent",
				today: "2026-11-15",
			},
		).groups.map((group) => group.items.map((item) => item.id)),
		[["p0"]],
	);
});

const NOW = "2026-11-15T09:30:00-05:00";

function answer(choice: string | null, note = "")
{
	return {
		choice,
		note,
		answeredAt: "2026-11-15T14:00:00.000Z",
	};
}

test("resolveRefineJournalAnswers maps every answer to ops to run, ledger rows to append, or a follow-up", () =>
{
	const answers =
	{
		p0: answer("accept"),
		p1: answer("opt1"),
		p2: answer("opt1"),
		p3: answer("opt1"),
		submittedAt: "2026-11-15T14:05:00.000Z",
	};
	assert.deepStrictEqual(
		resolveRefineJournalAnswers(
			{
				proposals,
				answers,
				ids: ["p0", "p1", "p2", "p3"],
				now: NOW,
			},
		),
		{
			apply: [
				{
					id: "p0",
					header: "Nov 4",
					ops: plain.applyOps,
				},
				{
					id: "p1",
					header: "Nov 5",
					ops: [
						"./bin/run.js node update --id 22222222-2222-4222-8222-222222222222 --name '🎂 Alice'\"'\"'s party' --expect-name 'Alice'\"'\"'s party'",
					],
				},
				{
					id: "p2",
					header: "Nov 5",
					ops: [
						"./bin/run.js node update --id 33333333-3333-4333-8333-333333333333 --name '🍽️ Lunch with @CarolJones' --expect-name 'Lunch with Carol'",
					],
				},
			],
			declined: [],
			followUp: [
				{
					id: "p3",
					header: "Nov 6",
					choice: "Change to mailed",
					note: "",
					reason: "The chosen option stages no text; confirm the exact wording and build the op with --expect-name",
				},
			],
			unanswered: [],
		},
	);
});

test("resolveRefineJournalAnswers declines Keep as written and skip-like options, and sends notes and blanks back to the walk", () =>
{
	const answers =
	{
		p0: answer("reject"),
		p1: answer("opt0", "use 🥳 instead"),
		p2: answer("opt2"),
		p3: answer(null),
	};
	assert.deepStrictEqual(
		resolveRefineJournalAnswers(
			{
				proposals,
				answers,
				ids: ["p0", "p1", "p2", "p3", "p4"],
				now: NOW,
			},
		),
		{
			apply: [],
			declined: [
				{
					nodeId: ID_A,
					before: "Ran with Bob ",
					after: "🏃 Ran with @Bob",
					declinedAt: NOW,
				},
				{
					nodeId: ID_C,
					before: "Lunch with Carol",
					after: "🍽️ Lunch with @CarolSmith",
					declinedAt: NOW,
				},
			],
			followUp: [
				{
					id: "p1",
					header: "Nov 5",
					choice: "🎉 party",
					note: "use 🥳 instead",
					reason: "The answer carries a note; apply it as Accept with note or a vocabulary explanation",
				},
			],
			unanswered: [
				{
					id: "p3",
					header: "Nov 6",
				},
				{
					id: "p4",
					header: "Jan 2",
				},
			],
		},
	);
});

test("resolveRefineJournalAnswers prepends a chosen emoji when the proposed After has none", () =>
{
	const bare =
	{
		...emojiPicker,
		after: "Alice's party",
		applyOps: undefined,
	};
	assert.deepStrictEqual(
		resolveRefineJournalAnswers(
			{
				proposals: [bare],
				answers:
				{
					p0: answer("opt0"),
				},
				ids: ["p0"],
				now: NOW,
			},
		).apply,
		[
			{
				id: "p0",
				header: "Nov 5",
				ops: [
					"./bin/run.js node update --id 22222222-2222-4222-8222-222222222222 --name '🎉 Alice'\"'\"'s party' --expect-name 'Alice'\"'\"'s party'",
				],
			},
		],
	);
});

function withDirectory(body: (directory: string) => void): void
{
	const directory = mkdtempSync(join(tmpdir(), "stage-refine-journal-page-test-"));
	try
	{
		body(directory);
	}
	finally
	{
		rmSync(
			directory,
			{
				recursive: true,
				force: true,
			},
		);
	}
}

function run(args: string[])
{
	const result = spawnSync(
		process.execPath,
		[script, ...args],
		{
			encoding: "utf8",
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function stagedFile(directory: string, status = "ready"): string
{
	const path = join(directory, "refine-journal.json");
	writeFileSync(
		path,
		JSON.stringify(
			{
				task: "refine-journal",
				generatedAt: NOW,
				status,
				summary:
				{
					archiveMonth: "2026-01",
				},
				proposals: status === "ready" ? proposals : [],
			},
		),
	);
	return path;
}

test("the stage CLI writes the decision page and prints its slug and card ids", () =>
{
	withDirectory((directory) =>
	{
		const decisions = join(directory, "decisions");
		const result = run([
			"stage",
			"--proposals",
			stagedFile(directory),
			"--decisions-dir",
			decisions,
			"--today",
			"2026-11-15",
		]);
		assert.deepStrictEqual(
			{
				...result,
				page: readJsonFile(join(decisions, "refine-journal-2026-11-15.json")),
			},
			{
				status: 0,
				stdout: `${JSON.stringify(
					{
						slug: "refine-journal-2026-11-15",
						ids: ["p0", "p1", "p2", "p3"],
					},
				)}\n`,
				stderr: "",
				page: recentPage,
			},
		);
	});
});

test("the stage CLI refuses a proposal file that is not ready", () =>
{
	withDirectory((directory) =>
	{
		assert.deepStrictEqual(
			run(["stage", "--proposals", stagedFile(directory, "empty"), "--decisions-dir", directory]),
			{
				status: 1,
				stdout: "",
				stderr: 'refine-journal proposals are "empty", not "ready"; nothing to stage\n',
			},
		);
	});
});

test("the resolve CLI reads the saved answers for the staged cards", () =>
{
	withDirectory((directory) =>
	{
		const decisions = join(directory, "decisions");
		mkdirSync(decisions);
		const proposalsPath = stagedFile(directory);
		writeFileSync(join(decisions, "refine-journal-2026-11-15.json"), JSON.stringify(recentPage));
		writeFileSync(
			join(decisions, "refine-journal-2026-11-15.answers.json"),
			JSON.stringify(
				{
					p0: answer("accept"),
				},
			),
		);
		const result = run([
			"resolve",
			"--slug",
			"refine-journal-2026-11-15",
			"--proposals",
			proposalsPath,
			"--decisions-dir",
			decisions,
			"--now",
			NOW,
		]);
		assert.deepStrictEqual(
			result,
			{
				status: 0,
				stdout: `${JSON.stringify(
					resolveRefineJournalAnswers(
						{
							proposals,
							answers:
							{
								p0: answer("accept"),
							},
							ids: ["p0", "p1", "p2", "p3"],
							now: NOW,
						},
					),
					null,
					2,
				)}\n`,
				stderr: "",
			},
		);
	});
});

test("the resolve CLI fails when no answers were saved", () =>
{
	withDirectory((directory) =>
	{
		writeFileSync(join(directory, "refine-journal-2026-11-15.json"), JSON.stringify(recentPage));
		const result = run([
			"resolve",
			"--slug",
			"refine-journal-2026-11-15",
			"--proposals",
			stagedFile(directory),
			"--decisions-dir",
			directory,
		]);
		assert.deepStrictEqual(
			result,
			{
				status: 1,
				stdout: "",
				stderr: `No answers saved for decision page refine-journal-2026-11-15 (${join(directory, "refine-journal-2026-11-15.answers.json")})\n`,
			},
		);
	});
});
