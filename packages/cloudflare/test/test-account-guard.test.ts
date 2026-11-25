import {describe, expect, it} from "vite-plus/test";
import {deletionRefusal, existingSessionRefusal} from "../smoke/test-account-guard";

describe("deletionRefusal", () =>
{
	const runStartedAt = new Date("2026-11-24T12:00:00.000Z");
	const session = (email: string, id: string, createdAt: string) => (
	{
		user:
		{
			id,
			email,
			createdAt,
		},
	});
	const fresh = session("Test@Example.com", "user-1", "2026-11-24T12:01:00.000Z");

	it("allows only the test account this run created, and names why it refuses any other", () =>
	{
		expect([
			deletionRefusal(
				{
					testEmail: "test@example.com",
					session: fresh,
					createdUserId: "user-1",
					runStartedAt,
				},
			),
			deletionRefusal(
				{
					testEmail: undefined,
					session: fresh,
					createdUserId: "user-1",
					runStartedAt,
				},
			),
			deletionRefusal(
				{
					testEmail: "test@example.com",
					session: null,
					createdUserId: "user-1",
					runStartedAt,
				},
			),
			deletionRefusal(
				{
					testEmail: "test@example.com",
					session: session("owner@example.com", "user-1", "2026-11-24T12:01:00.000Z"),
					createdUserId: "user-1",
					runStartedAt,
				},
			),
			deletionRefusal(
				{
					testEmail: "test@example.com",
					session: fresh,
					createdUserId: "user-2",
					runStartedAt,
				},
			),
			deletionRefusal(
				{
					testEmail: "test@example.com",
					session: session("test@example.com", "user-1", "2026-11-01T00:00:00.000Z"),
					createdUserId: "user-1",
					runStartedAt,
				},
			),
		]).toStrictEqual([
			null,
			"OUTLINEDB_TEST_EMAIL is not set",
			"no one is signed in",
			"the signed-in account is not the test email",
			"the signed-in account is not the one this run signed up",
			"the account existed before this run started",
		]);
	});
});

describe("existingSessionRefusal", () =>
{
	it("lets the run start only when the profile has no OutlineDB session cookie and no one is signed in", () =>
	{
		const signedIn =
		{
			user:
			{
				id: "user-1",
				email: "test@example.com",
				createdAt: "2026-11-01T00:00:00.000Z",
			},
		};
		expect([
			existingSessionRefusal(
				{
					cookieNames: ["theme", "__cf_bm"],
					session: null,
				},
			),
			existingSessionRefusal(
				{
					cookieNames: ["theme", "__Secure-better-auth.session_token"],
					session: null,
				},
			),
			existingSessionRefusal(
				{
					cookieNames: ["better-auth.session_token"],
					session: null,
				},
			),
			existingSessionRefusal(
				{
					cookieNames: [],
					session: signedIn,
				},
			),
		]).toStrictEqual([
			null,
			"the profile already has an OutlineDB session cookie (__Secure-better-auth.session_token)",
			"the profile already has an OutlineDB session cookie (better-auth.session_token)",
			"the profile is already signed in to OutlineDB as test@example.com",
		]);
	});
});
