import {describe, expect, it} from "vite-plus/test";
import {parseTestUserRows, testUserQuery, walkthroughRefusal} from "../smoke/test-account-guard";

describe("testUserQuery", () =>
{
	it("selects the user row by case-insensitive email, quoting the email as an SQL string", () =>
	{
		expect([testUserQuery("Test@Example.com"), testUserQuery("o'brien@example.com")]).toStrictEqual([
			'SELECT id, "createdAt", "emailVerified", provisioned_at FROM "user" WHERE lower(email) = lower(\'Test@Example.com\')',
			'SELECT id, "createdAt", "emailVerified", provisioned_at FROM "user" WHERE lower(email) = lower(\'o\'\'brien@example.com\')',
		]);
	});
});

describe("parseTestUserRows", () =>
{
	it("reads the rows of `wrangler d1 execute --json` output", () =>
	{
		const output = JSON.stringify([
			{
				results: [
					{
						id: "user-1",
						createdAt: "2026-11-24T12:01:00.000Z",
						emailVerified: 1,
						provisioned_at: "2026-11-24T12:02:00.000Z",
					},
					{
						id: "user-2",
						createdAt: "2026-11-24T12:03:00.000Z",
						emailVerified: 0,
						provisioned_at: null,
					},
				],
				success: true,
				meta:
				{
					changes: 0,
				},
			},
		]);
		expect([
			parseTestUserRows(output),
			parseTestUserRows(
				JSON.stringify([
					{
						results: [],
						success: true,
					},
				]),
			),
		]).toStrictEqual([
			[
				{
					id: "user-1",
					createdAt: "2026-11-24T12:01:00.000Z",
					emailVerified: true,
					provisionedAt: "2026-11-24T12:02:00.000Z",
				},
				{
					id: "user-2",
					createdAt: "2026-11-24T12:03:00.000Z",
					emailVerified: false,
					provisionedAt: null,
				},
			],
			[],
		]);
	});

	it("throws on output that is not a successful single-statement result", () =>
	{
		expect(() => parseTestUserRows("not json")).toThrow("is not valid JSON");
		expect(() =>
			parseTestUserRows(
				JSON.stringify([
					{
						results: [],
						success: false,
					},
				]),
			),
		).toThrow('wrangler d1 execute did not succeed: [{"results":[],"success":false}]');
		expect(() =>
			parseTestUserRows(
				JSON.stringify([
					{
						results: [
							{
								id: "user-1",
								createdAt: 5,
								emailVerified: 1,
								provisioned_at: null,
							},
						],
						success: true,
					},
				]),
			),
		).toThrow('unexpected user row: {"id":"user-1","createdAt":5,"emailVerified":1,"provisioned_at":null}');
	});
});

describe("walkthroughRefusal", () =>
{
	const runStartedAt = new Date("2026-11-24T12:00:00.000Z");
	const row = (
		overrides: Partial<
		{
			id: string;
			createdAt: string;
			emailVerified: boolean;
			provisionedAt: string | null;
		}> = {},
	) => (
	{
		id: "user-1",
		createdAt: "2026-11-24T12:01:00.000Z",
		emailVerified: false,
		provisionedAt: null,
		...overrides,
	});
	const verified = row(
		{
			emailVerified: true,
		},
	);
	const provisioned = row(
		{
			emailVerified: true,
			provisionedAt: "2026-11-24T12:02:00.000Z",
		},
	);

	it("passes each stage only when D1 holds the brand-new account this run made, in the state that stage expects", () =>
	{
		expect([
			walkthroughRefusal("before signup", [], runStartedAt),
			walkthroughRefusal("signed up", [row()], runStartedAt),
			walkthroughRefusal("verified", [verified], runStartedAt),
			walkthroughRefusal("provisioned", [provisioned], runStartedAt),
			walkthroughRefusal("deleted", [], runStartedAt),
		]).toStrictEqual([null, null, null, null, null]);
	});

	it("names why it refuses", () =>
	{
		expect([
			walkthroughRefusal("before signup", [row()], runStartedAt),
			walkthroughRefusal("signed up", [], runStartedAt),
			walkthroughRefusal(
				"signed up",
				[
					row(),
					row(
						{
							id: "user-2",
						},
					),
				],
				runStartedAt,
			),
			walkthroughRefusal(
				"signed up",
				[
					row(
						{
							createdAt: "2026-11-01T00:00:00.000Z",
						},
					),
				],
				runStartedAt,
			),
			walkthroughRefusal(
				"signed up",
				[
					row(
						{
							createdAt: "yesterday",
						},
					),
				],
				runStartedAt,
			),
			walkthroughRefusal("verified", [row()], runStartedAt),
			walkthroughRefusal("provisioned", [verified], runStartedAt),
			walkthroughRefusal(
				"provisioned",
				[
					{
						...provisioned,
						emailVerified: false,
					},
				],
				runStartedAt,
			),
			walkthroughRefusal("deleted", [provisioned], runStartedAt),
		]).toStrictEqual([
			"a user with the test email already exists (created 2026-11-24T12:01:00.000Z); the run must start with a brand-new email",
			"no user with the test email exists yet",
			"2 users have the test email",
			"the user was created at 2026-11-01T00:00:00.000Z, before this run started at 2026-11-24T12:00:00.000Z",
			"the user was created at yesterday, before this run started at 2026-11-24T12:00:00.000Z",
			"the email is not verified yet",
			"the account is not provisioned yet (provisioned_at is null)",
			"the email is not verified yet",
			"the user still exists (created 2026-11-24T12:01:00.000Z)",
		]);
	});
});
