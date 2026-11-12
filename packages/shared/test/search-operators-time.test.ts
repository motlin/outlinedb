import {describe, expect, it} from "vite-plus/test";
import {parseQuery} from "../src/search/index.js";
import {sinceTimestamp} from "../src/search/operators/time.js";
import {searchItem} from "./helpers/search-so-fixture.js";

const NOW = Date.UTC(2026, 9, 1, 12);
const HOUR = 3_600_000;
const MINUTE = 60_000;

function matches(query: string, overrides: Parameters<typeof searchItem>[2]): boolean
{
	return parseQuery(
		query,
		{
			now: NOW,
		},
	).matches(searchItem("x", "", overrides)).matches;
}

describe("sinceTimestamp", () =>
{
	it("parses h, d and bare minutes, treating other suffixes as minutes and junk as zero", () =>
	{
		expect([
			sinceTimestamp("1h", NOW),
			sinceTimestamp("7d", NOW),
			sinceTimestamp("1w", NOW),
			sinceTimestamp("30", NOW),
			sinceTimestamp("x", NOW),
			sinceTimestamp("-5d", NOW),
		]).toStrictEqual([NOW - 3_600_000, NOW - 604_800_000, NOW - 60_000, NOW - 1_800_000, NOW, NOW]);
	});
});

describe("time-range operators", () =>
{
	it("changed:1d matches an item modified 23h ago but not 25h ago, as a meta match", () =>
	{
		expect(
			parseQuery(
				"changed:1d",
				{
					now: NOW,
				},
			).matches(
				searchItem(
					"x",
					"",
					{
						modifiedAt: NOW - 23 * HOUR,
					},
				),
			),
		).toStrictEqual(
			{
				matches: true,
				nameMatches: false,
				noteMatches: false,
				metaMatches: true,
			},
		);
		expect(
			matches(
				"changed:1d",
				{
					modifiedAt: NOW - 25 * HOUR,
				},
			),
		).toBe(false);
		expect(
			matches(
				"changed:1d",
				{
					modifiedAt: null,
				},
			),
		).toBe(false);
	});

	it("last-changed: and last-changed-since: alias changed:, and last-changed:7d keeps working", () =>
	{
		expect([
			matches(
				"last-changed:7d",
				{
					modifiedAt: NOW - 6 * 24 * HOUR,
				},
			),
			matches(
				"last-changed:7d",
				{
					modifiedAt: NOW - 8 * 24 * HOUR,
				},
			),
			matches(
				"last-changed-since:2h",
				{
					modifiedAt: NOW - HOUR,
				},
			),
			matches(
				"last-changed-since:2h",
				{
					modifiedAt: NOW - 3 * HOUR,
				},
			),
		]).toStrictEqual([true, false, true, false]);
	});

	it("last-changed-before: matches items modified before the cutoff", () =>
	{
		expect([
			matches(
				"last-changed-before:1d",
				{
					modifiedAt: NOW - 25 * HOUR,
				},
			),
			matches(
				"last-changed-before:1d",
				{
					modifiedAt: NOW - 23 * HOUR,
				},
			),
		]).toStrictEqual([true, false]);
	});

	it("created:1h matches an item created 59 minutes ago", () =>
	{
		expect([
			matches(
				"created:1h",
				{
					createdAt: NOW - 59 * MINUTE,
				},
			),
			matches(
				"created:1h",
				{
					createdAt: NOW - 61 * MINUTE,
				},
			),
		]).toStrictEqual([true, false]);
	});

	it("completed: and completed-since: match on completedAt", () =>
	{
		expect([
			matches(
				"completed:1d",
				{
					completedAt: NOW - HOUR,
				},
			),
			matches(
				"completed-since:1d",
				{
					completedAt: NOW - HOUR,
				},
			),
			matches(
				"completed:1d",
				{
					completedAt: NOW - 25 * HOUR,
				},
			),
			matches(
				"completed:1d",
				{
					completedAt: null,
				},
			),
		]).toStrictEqual([true, true, false, false]);
	});
});

describe("changed-by operators", () =>
{
	it("changed-by:me and last-changed-by:me match everything; changed-by:others matches nothing", () =>
	{
		expect([
			matches("changed-by:me", {}),
			matches("last-changed-by:me", {}),
			matches("changed-by:others", {}),
			matches("last-changed-by:others", {}),
		]).toStrictEqual([true, true, false, false]);
	});
});
