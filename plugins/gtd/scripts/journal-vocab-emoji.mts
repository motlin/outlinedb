#!/usr/bin/env node
// Look up a journal entry's emoji in the gitignored journal vocabulary.
//
// refine-journal-prep auto-picks the emoji on a hit instead of staging a picker, and
// refine-journal-apply skips the "save this emoji row" offer when a row already matches.
// Terms and emoji stay in the vocabulary file, never in this plugin.
//
//   node journal-vocab-emoji.mts lookup "<entry text or term>" [--file .llm/gtd/journal-vocabulary.md]
//     -> {emoji, matches: [{term, emoji}]}   emoji is null on a miss
//
// Every markdown table with an "Emoji" column counts. A term cell's quotes and parenthetical
// context are dropped and " / " alternates split into separate terms. Matching is
// case-insensitive on whole words, longest term first. The emoji is returned byte-for-byte,
// so a U+FE0F variation selector survives.

import {readFileSync} from "node:fs";
import {takeValue} from "./cli-args.mts";
import {isMain} from "./is-main.mts";

export interface EmojiRow
{
	term: string;
	emoji: string;
}

export interface LookupResult
{
	emoji: string | null;
	matches: EmojiRow[];
}

const DEFAULT_FILE = ".llm/gtd/journal-vocabulary.md";

function splitRow(line: string): string[]
{
	return line
		.trim()
		.replace(/^\|/u, "")
		.replace(/\|$/u, "")
		.split("|")
		.map((cell) => cell.trim());
}

function isTableLine(line: string): boolean
{
	return line.trim().startsWith("|");
}

function isSeparator(cells: string[]): boolean
{
	return cells.every((cell) => /^:?-+:?$/u.test(cell));
}

function termsOf(cell: string): string[]
{
	return cell
		.replaceAll(/\([^)]*\)/gu, "")
		.split("/")
		.map((term) => term.replaceAll('"', "").trim())
		.filter((term) => term !== "");
}

export function parseEmojiTable(markdown: string): EmojiRow[]
{
	const rows: EmojiRow[] = [];
	const lines = markdown.split("\n");
	let emojiColumn = -1;
	for (let i = 0; i < lines.length; i++)
	{
		const line = lines[i] ?? "";
		if (!isTableLine(line))
		{
			emojiColumn = -1;
			continue;
		}
		const cells = splitRow(line);
		const next = lines[i + 1];
		if (next !== undefined && isTableLine(next) && isSeparator(splitRow(next)))
		{
			emojiColumn = cells.findIndex((cell) => cell.toLowerCase() === "emoji");
			i++;
			continue;
		}
		if (emojiColumn < 0)
		{
			continue;
		}
		const emoji = cells[emojiColumn];
		if (emoji === undefined || emoji === "")
		{
			continue;
		}
		for (const term of termsOf(cells[0] ?? ""))
		{
			rows.push(
				{
					term,
					emoji,
				},
			);
		}
	}
	return rows;
}

function escapeRegExp(text: string): string
{
	return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

export function lookupEmoji(rows: EmojiRow[], text: string): LookupResult
{
	const matches = rows
		.filter(({term}) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "iu").test(text))
		.toSorted((a, b) => b.term.length - a.term.length);
	return {
		emoji: matches[0]?.emoji ?? null,
		matches,
	};
}

export function main(argv: string[]): LookupResult
{
	const args = argv[Symbol.iterator]();
	let command: string | undefined;
	let text: string | undefined;
	let file = DEFAULT_FILE;
	for (const arg of args)
	{
		if (arg === "--file")
		{
			file = takeValue(args, arg);
		}
		else if (command === undefined)
		{
			command = arg;
		}
		else if (text === undefined)
		{
			text = arg;
		}
		else
		{
			throw new Error(`Unexpected argument: ${arg}`);
		}
	}
	if (command !== "lookup" || text === undefined)
	{
		throw new Error('Usage: journal-vocab-emoji.mts lookup "<text>" [--file <path>]');
	}
	return lookupEmoji(parseEmojiTable(readFileSync(file, "utf8")), text);
}

if (isMain(import.meta.url))
{
	console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
}
