import {describe, expect, it} from "vite-plus/test";
import {profileForEmail} from "../smoke/chrome-profile";

describe("profileForEmail", () =>
{
	const localState = (accounts: Record<string, string>) => (
	{
		profile:
		{
			info_cache: Object.fromEntries(
				Object.entries(accounts).map(([directory, userName]) => [
					directory,
					{
						name: `Person ${directory}`,
						user_name: userName,
					},
				]),
			),
		},
	});

	it("finds the one profile signed in as the email, ignoring case, and names why it cannot otherwise", () =>
	{
		const profiles = localState(
			{
				Default: "owner@example.com",
				"Profile 1": "Test@Example.com",
				"Profile 2": "",
			},
		);
		expect([
			profileForEmail(profiles, "test@example.com"),
			profileForEmail(profiles, "nobody@example.com"),
			profileForEmail(
				localState(
					{
						"Profile 1": "test@example.com",
						"Profile 3": "TEST@example.com",
					},
				),
				"test@example.com",
			),
			profileForEmail({}, "test@example.com"),
		]).toStrictEqual([
			{
				directory: "Profile 1",
			},
			{
				refusal: "no Chrome profile is signed in as nobody@example.com",
			},
			{
				refusal: "more than one Chrome profile is signed in as test@example.com: Profile 1, Profile 3",
			},
			{
				refusal: "Chrome's Local State lists no profiles",
			},
		]);
	});
});
