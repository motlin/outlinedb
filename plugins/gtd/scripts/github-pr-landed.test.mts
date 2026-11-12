// Run: node --test plugins/gtd/scripts/github-pr-landed.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {classifyPr, formatTitle, landedText, parsePrUrl, timeElement} from "./github-pr-landed.mts";
import type {PullRequest} from "./github-pr-landed.mts";

test("parsePrUrl canonicalizes a notification link with a referrer query and event anchor", () =>
{
	assert.deepStrictEqual(
		parsePrUrl("https://github.com/acme/widgets/pull/42?notification_referrer_id=NT_abc#event-123"),
		{
			url: "https://github.com/acme/widgets/pull/42",
			host: "github.com",
			repo: "acme/widgets",
			number: 42,
		},
	);
});

test("parsePrUrl accepts PR sub-pages and other GitHub hosts", () =>
{
	assert.deepStrictEqual(
		parsePrUrl("https://git.example.com/team/tool/pull/7/files"),
		{
			url: "https://git.example.com/team/tool/pull/7",
			host: "git.example.com",
			repo: "team/tool",
			number: 7,
		},
	);
});

test("parsePrUrl returns null for URLs that are not pull requests", () =>
{
	assert.deepStrictEqual(
		["https://github.com/acme/widgets/issues/3", "https://example.com/spec", "not a url"].map(parsePrUrl),
		[null, null, null],
	);
});

test("formatTitle escapes HTML and turns backtick spans into code elements", () =>
{
	assert.strictEqual(
		formatTitle("Leave a `def` alone when a < b & c"),
		"Leave a <code>def</code> alone when a &lt; b &amp; c",
	);
});

test("timeElement renders the Workflowy date element with a computed weekday", () =>
{
	assert.strictEqual(
		timeElement(
			{
				year: 2026,
				month: 9,
				day: 23,
			},
		),
		'<time startYear="2026" startMonth="9" startDay="23">Wed, Sep 23, 2026</time>',
	);
});

const merged: PullRequest =
{
	number: 42,
	title: "Fix the `frob` step",
	url: "https://github.com/acme/widgets/pull/42",
	author:
	{
		login: "alice",
	},
	state: "MERGED",
	mergedAt: "2026-09-24T02:30:00Z",
};

test("landedText marks github.com PRs as open source", () =>
{
	assert.strictEqual(
		landedText(
			merged,
			{
				year: 2026,
				month: 9,
				day: 23,
			},
		),
		'Landed <a href="https://github.com/acme/widgets/pull/42">Fix the <code>frob</code> step</a> #42 in open source, in acme/widgets <time startYear="2026" startMonth="9" startDay="23">Wed, Sep 23, 2026</time>',
	);
});

test("landedText omits open source for other hosts", () =>
{
	assert.strictEqual(
		landedText(
			{
				...merged,
				url: "https://git.example.com/team/tool/pull/7",
				number: 7,
				title: "Tidy",
			},
			{
				year: 2026,
				month: 1,
				day: 5,
			},
		),
		'Landed <a href="https://git.example.com/team/tool/pull/7">Tidy</a> #7 in team/tool <time startYear="2026" startMonth="1" startDay="5">Mon, Jan 5, 2026</time>',
	);
});

test("classifyPr routes an own merged PR using the local merge date", () =>
{
	assert.deepStrictEqual(
		classifyPr(
			merged,
			{
				githubLogins: ["Alice"],
			},
			"America/New_York",
		),
		{
			repo: "acme/widgets",
			number: 42,
			title: "Fix the `frob` step",
			url: "https://github.com/acme/widgets/pull/42",
			author: "alice",
			state: "MERGED",
			mergedAt: "2026-09-24T02:30:00Z",
			own: true,
			ownMerged: true,
			year: 2026,
			landedText:
				'Landed <a href="https://github.com/acme/widgets/pull/42">Fix the <code>frob</code> step</a> #42 in open source, in acme/widgets <time startYear="2026" startMonth="9" startDay="23">Wed, Sep 23, 2026</time>',
		},
	);
});

test("classifyPr does not route PRs by someone else or not yet merged", () =>
{
	const config =
	{
		githubLogins: ["alice"],
	};
	const results = [
		classifyPr(
			{
				...merged,
				author:
				{
					login: "bob",
				},
			},
			config,
			"UTC",
		),
		classifyPr(
			{
				...merged,
				state: "OPEN",
				mergedAt: null,
			},
			config,
			"UTC",
		),
		classifyPr(merged, null, "UTC"),
	].map(({own, ownMerged, year, landedText: text}) => (
	{
		own,
		ownMerged,
		year,
		text,
	}));
	assert.deepStrictEqual(results, [
		{
			own: false,
			ownMerged: false,
			year: null,
			text: null,
		},
		{
			own: true,
			ownMerged: false,
			year: null,
			text: null,
		},
		{
			own: false,
			ownMerged: false,
			year: null,
			text: null,
		},
	]);
});
