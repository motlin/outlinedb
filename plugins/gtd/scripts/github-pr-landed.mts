// Classify a GitHub pull request captured into the inbox, and compose its performance-notes entry.
//
// A notification for the user's own merged PR is a work accomplishment, not something to read.
// Refinement routes it to the user's per-year performance notes as a "Landed <link> #N in <repo>
// <date>" entry. Which logins count as "own" lives in a gitignored config, never in this plugin.
//
//   node github-pr-landed.mts parse <url>
//     -> {url, host, repo, number} canonical PR reference, or null
//   gh pr view <url> --json number,title,url,author,state,mergedAt > pr.json
//   node github-pr-landed.mts classify pr.json [--config .llm/gtd/performance-notes.json]
//     -> {repo, number, title, url, author, state, mergedAt, own, ownMerged, year, landedText}

import {arrayField, expectObject, isObject, readJsonFile, stringField} from "./json.mts";
import {isMain} from "./is-main.mts";

export interface PullRequest
{
	number: number;
	title: string;
	url: string;
	author?:
	{
		login: string;
	} | null;
	state: string;
	mergedAt?: string | null;
}

export interface PerformanceNotesConfig
{
	githubLogins?: string[];
}

export interface PrRef
{
	url: string;
	host: string;
	repo: string;
	number: number;
}

export interface LocalDate
{
	year: number;
	month: number;
	day: number;
}

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/u;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parsePrUrl(raw: string): PrRef | null
{
	let parsed: URL;
	try
	{
		parsed = new URL(raw);
	}
	catch
	{
		return null;
	}
	const match = PR_PATH.exec(parsed.pathname);
	if (!match)
	{
		return null;
	}
	const [, owner, name, number] = match;
	return {
		url: `${parsed.origin}/${owner}/${name}/pull/${number}`,
		host: parsed.host,
		repo: `${owner}/${name}`,
		number: Number(number),
	};
}

const escapeHtml = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function formatTitle(title: string): string
{
	return escapeHtml(title).replaceAll(/`([^`]+)`/gu, "<code>$1</code>");
}

export function timeElement({year, month, day}: LocalDate): string
{
	const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
	return `<time startYear="${year}" startMonth="${month}" startDay="${day}">${weekday}, ${MONTHS[month - 1] ?? ""} ${day}, ${year}</time>`;
}

export function landedText(pr: PullRequest, date: LocalDate): string
{
	const ref = parsePrUrl(pr.url);
	if (!ref)
	{
		throw new TypeError(`not a pull request URL: ${pr.url}`);
	}
	const where = ref.host === "github.com" ? `in open source, in ${ref.repo}` : `in ${ref.repo}`;
	return `Landed <a href="${pr.url}">${formatTitle(pr.title)}</a> #${pr.number} ${where} ${timeElement(date)}`;
}

function localDate(iso: string, timeZone: string): LocalDate
{
	const parts = new Intl.DateTimeFormat(
		"en-US",
		{
			timeZone,
			year: "numeric",
			month: "numeric",
			day: "numeric",
		},
	).formatToParts(new Date(iso));
	const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
	return {
		year: part("year"),
		month: part("month"),
		day: part("day"),
	};
}

export interface PrClassification
{
	repo: string | null;
	number: number;
	title: string;
	url: string;
	author: string | null;
	state: string;
	mergedAt: string | null;
	own: boolean;
	ownMerged: boolean;
	year: number | null;
	landedText: string | null;
}

export function classifyPr(pr: PullRequest, config: PerformanceNotesConfig | null, timeZone: string): PrClassification
{
	const ref = parsePrUrl(pr.url);
	const author = pr.author?.login ?? null;
	const logins = (config?.githubLogins ?? []).map((login) => login.toLowerCase());
	const own = author !== null && logins.includes(author.toLowerCase());
	const mergedAt = pr.mergedAt ?? null;
	const ownMerged = own && pr.state === "MERGED" && Boolean(mergedAt);
	const date = ownMerged && mergedAt !== null ? localDate(mergedAt, timeZone) : null;
	return {
		repo: ref?.repo ?? null,
		number: pr.number,
		title: pr.title,
		url: pr.url,
		author,
		state: pr.state,
		mergedAt,
		own,
		ownMerged,
		year: date?.year ?? null,
		landedText: date ? landedText(pr, date) : null,
	};
}

function readConfig(path: string): PerformanceNotesConfig | null
{
	let parsed: unknown;
	try
	{
		parsed = readJsonFile(path);
	}
	catch
	{
		return null;
	}
	if (!isObject(parsed))
	{
		return {};
	}
	return {
		githubLogins: arrayField(parsed, "githubLogins").filter((login) => typeof login === "string"),
	};
}

function toPullRequest(value: unknown): PullRequest
{
	const pr = expectObject(value, "pr.json");
	const author = isObject(pr.author) ? stringField(pr.author, "login") : undefined;
	return {
		number: typeof pr.number === "number" ? pr.number : Number.NaN,
		title: stringField(pr, "title") ?? "",
		url: stringField(pr, "url") ?? "",
		author:
			author === undefined
				? null
				:
					{
						login: author,
					},
		state: stringField(pr, "state") ?? "",
		mergedAt: stringField(pr, "mergedAt") ?? null,
	};
}

function main(argv: readonly string[]): PrRef | PrClassification | null
{
	const [command, arg = "", ...rest] = argv;
	if (command === "parse")
	{
		return parsePrUrl(arg);
	}
	if (command === "classify")
	{
		const configIndex = rest.indexOf("--config");
		const configPath = configIndex === -1 ? ".llm/gtd/performance-notes.json" : (rest[configIndex + 1] ?? "");
		const pr = toPullRequest(readJsonFile(arg));
		return classifyPr(pr, readConfig(configPath), Intl.DateTimeFormat().resolvedOptions().timeZone);
	}
	throw new Error("usage: github-pr-landed.mts parse <url> | classify <pr.json> [--config <path>]");
}

if (isMain(import.meta.url))
{
	console.log(JSON.stringify(main(process.argv.slice(2)), null, 2));
}
