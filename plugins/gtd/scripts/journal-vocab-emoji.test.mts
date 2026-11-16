// Run: node --test plugins/gtd/scripts/journal-vocab-emoji.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {lookupEmoji, parseEmojiTable} from "./journal-vocab-emoji.mts";

const VOCABULARY = `# Journal vocabulary

## Hired-service terms

| Term in entries | Means | Emoji |
| --- | --- | --- |
| "window crew" | The hired window washers | 🪟 |
| (user washing, no crew named) | The user did it personally | 🧼 |

## Household terms

| Term in entries | Means | Noted |
| --- | --- | --- |
| "porch soup" | Rain pooling on the porch | 2026-01-01 |

## Holiday, observance, community event, and place emoji

| Holiday, observance, event, or place | Emoji | Noted |
| --- | --- | --- |
| Lantern Festival | 🏮 | 2026-01-02 |
| peace march / peace vigil | ☮️ | 2026-01-03 |
| hall (choir practice / open mic nights) | 🎤 | 2026-01-04 |
`;

test("parseEmojiTable reads every table with an Emoji column, splitting slash alternates and dropping parenthetical context", () =>
{
	assert.deepStrictEqual(parseEmojiTable(VOCABULARY), [
		{
			term: "window crew",
			emoji: "🪟",
		},
		{
			term: "Lantern Festival",
			emoji: "🏮",
		},
		{
			term: "peace march",
			emoji: "☮️",
		},
		{
			term: "peace vigil",
			emoji: "☮️",
		},
		{
			term: "hall",
			emoji: "🎤",
		},
	]);
});

test("lookupEmoji matches a term case-insensitively inside entry text and keeps U+FE0F", () =>
{
	const rows = parseEmojiTable(VOCABULARY);
	const result = lookupEmoji(rows, "Walked in the PEACE VIGIL downtown");
	assert.deepStrictEqual(
		result,
		{
			emoji: "☮️",
			matches: [
				{
					term: "peace vigil",
					emoji: "☮️",
				},
			],
		},
	);
});

test("lookupEmoji matches whole words only and returns null emoji on a miss", () =>
{
	const rows = parseEmojiTable(VOCABULARY);
	assert.deepStrictEqual(
		lookupEmoji(rows, "Cleaned the hallway"),
		{
			emoji: null,
			matches: [],
		},
	);
});

test("lookupEmoji prefers the longest matching term", () =>
{
	const rows = [
		{
			term: "festival",
			emoji: "🎪",
		},
		{
			term: "Lantern Festival",
			emoji: "🏮",
		},
	];
	assert.deepStrictEqual(
		lookupEmoji(rows, "lantern festival at the hall"),
		{
			emoji: "🏮",
			matches: [
				{
					term: "Lantern Festival",
					emoji: "🏮",
				},
				{
					term: "festival",
					emoji: "🎪",
				},
			],
		},
	);
});
