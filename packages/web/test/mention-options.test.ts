import {describe, expect, it} from "vite-plus/test";
import {avatarInitials, insertSuggestion, matchesTerm, mentionGroups} from "../src/client/mention-options.js";

const account =
{
	userId: 7,
	fullName: "Alice Smith",
};

describe("mentionGroups", () =>
{
	it("lists the current user then the canonical tags", () =>
	{
		expect(
			mentionGroups(
				{
					term: "",
					account,
					tags: ["@mdAlpha"],
				},
			),
		).toStrictEqual([
			{
				name: "People",
				options: [
					{
						kind: "person",
						id: "7",
						text: "Alice Smith",
					},
				],
			},
			{
				name: "Tags",
				options: [
					{
						kind: "tag",
						text: "@mdAlpha",
					},
				],
			},
		]);
	});

	it("keeps the tag's stored case and drops People when the term does not match", () =>
	{
		expect(
			mentionGroups(
				{
					term: "MDa",
					account,
					tags: ["@mdAlpha"],
				},
			),
		).toStrictEqual([
			{
				name: "Tags",
				options: [
					{
						kind: "tag",
						text: "@mdAlpha",
					},
				],
			},
		]);
	});

	it("keeps People for me and drops everything when nothing matches", () =>
	{
		expect([
			mentionGroups(
				{
					term: "me",
					account,
					tags: [],
				},
			),
			mentionGroups(
				{
					term: "zz",
					account,
					tags: [],
				},
			),
			mentionGroups(
				{
					term: "*",
					account,
					tags: [],
				},
			).length,
		]).toStrictEqual([
			[
				{
					name: "People",
					options: [
						{
							kind: "person",
							id: "7",
							text: "Alice Smith",
						},
					],
				},
			],
			[],
			1,
		]);
	});

	it("caps tags at eight", () =>
	{
		const tags = Array.from(
			{
				length: 12,
			},
			(_, i) => `@t${i}`,
		);
		expect(
			mentionGroups(
				{
					term: "t",
					account: null,
					tags,
				},
			)[0]?.options.length,
		).toBe(8);
	});
});

describe("matchesTerm", () =>
{
	it("is a case-insensitive prefix test and * matches all", () =>
	{
		expect([matchesTerm("al", "Alice"), matchesTerm("x", "Alice"), matchesTerm("*", "Alice")]).toStrictEqual([
			true,
			false,
			true,
		]);
	});
});

describe("avatarInitials", () =>
{
	it("takes the first and last words' first letters", () =>
	{
		expect([avatarInitials("Alice B Smith"), avatarInitials("Cher"), avatarInitials("")]).toStrictEqual([
			"AS",
			"C",
			"",
		]);
	});
});

describe("insertSuggestion", () =>
{
	it("spaces the insert on both sides", () =>
	{
		expect([insertSuggestion("q@", 1, 2, "@mdBeta"), insertSuggestion("@ x", 0, 1, "@a")]).toStrictEqual([
			{
				text: "q @mdBeta ",
				caret: 10,
			},
			{
				text: "@a x",
				caret: 3,
			},
		]);
	});
});
