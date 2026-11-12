import {ancestorChain} from "@outlinedb/shared/cache";
import type {CacheService} from "@outlinedb/shared/cache";
import {dayNameDate} from "@outlinedb/shared/calendar-lookup";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {findTags} from "@outlinedb/shared/tags";
import {buildShortlistRequests, buildVerifyRequest, selectShortlist} from "./clef-requests.js";
import type {ChoiceAnswer, ClefClient, ClefModel, ClefState, ShortlistEntry} from "./clef-requests.js";
import type {PoolLabel} from "./label-pool.js";
import type {LabelSuggestion} from "./label-suggestions.js";

/**
 * The entries under `rootId`, in outline order: its children, with each calendar day (a date-only `<time>` name)
 * replaced by the day's children. A month yields its journal entries; the Inbox yields its items.
 */
export function scopeEntries(cache: CacheService, rootId: string): string[]
{
	return cache
		.getChildren(rootId)
		.flatMap((child) =>
			dayNameDate(child.name) === undefined ? [child.id] : cache.getChildren(child.id).map(({id}) => id),
		);
}

const YEAR_MONTH = /^(\d{4})-(\d{2})$/u;

/** Parses a `YYYY-MM` flag value for {@link calendarEntriesSince}. */
export async function parseYearMonth(
	input: string,
	flag: string,
): Promise<
{
	year: number;
	month: number;
}>
{
	const [, year, month] = YEAR_MONTH.exec(input) ?? [];
	return year === undefined || month === undefined
		? Promise.reject(new Error(`${flag} must be YYYY-MM, got "${input}"`))
		: Promise.resolve(
				{
					year: Number(year),
					month: Number(month),
				},
			);
}

/** Calendar > 🗃️ Archive > decade > year > month > week > day. */
const MAX_DAY_DEPTH = 6;

/**
 * The journal entries (children of calendar days) under `rootId` on days in or after `since`, in outline order.
 * Days are date-only `<time>` nodes found at most {@link MAX_DAY_DEPTH} levels below the root.
 */
export function calendarEntriesSince(
	cache: CacheService,
	rootId: string,
	since:
	{
		readonly year: number;
		readonly month: number;
	},
): string[]
{
	const sinceKey = since.year * 100 + since.month;
	const visit = (parentId: string, depth: number): string[] =>
		cache.getChildren(parentId).flatMap((child) =>
		{
			const day = dayNameDate(child.name);
			if (day !== undefined)
			{
				return day.year * 100 + day.month >= sinceKey ? cache.getChildren(child.id).map(({id}) => id) : [];
			}
			return depth < MAX_DAY_DEPTH ? visit(child.id, depth + 1) : [];
		});
	return visit(rootId, 1);
}

/** What Clef reads about an entry, and the `@mentions`/`#tags` it already carries. */
export function entryState(
	cache: CacheService,
	nodeId: string,
):
{
	state: ClefState;
	labels: string[];
}
{
	const [node, ...ancestors] = ancestorChain(nodeId, (id) => cache.getNode(id));
	const entry = stripHtmlTags(node?.name ?? "");
	const day = ancestors.map(({name}) => dayNameDate(name)).find((date) => date !== undefined);
	const date =
		day === undefined
			? ""
			: `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
	const parent = ancestors
		.toReversed()
		.map(({name}) => stripHtmlTags(name))
		.join(" > ");
	return {
		state:
		{
			date,
			parent,
			entry,
		},
		labels: findTags(entry).map(({tag}) => tag),
	};
}

/** The text of the other entries under `nodeId`'s parent (its calendar day), in outline order, at most `limit`. */
export function siblingTexts(cache: CacheService, nodeId: string, limit: number): string[]
{
	const parentId = cache.getNode(nodeId)?.parentId;
	return parentId == null
		? []
		: cache
				.getChildren(parentId)
				.filter(({id}) => id !== nodeId)
				.slice(0, limit)
				.map(({name}) => stripHtmlTags(name));
}

/** One Clef pass over an entry: what it returned and the `usage.input_tokens` its requests cost. */
export interface PassResult<T>
{
	readonly value: T;
	readonly requests: number;
	readonly inputTokens: number;
}

/** Pass 1: the `choice` shortlist over `pool` on Clef-flash. */
export async function runShortlist(
	client: ClefClient,
	pool: readonly PoolLabel[],
	state: ClefState,
): Promise<PassResult<ShortlistEntry[]>>
{
	const choiceAnswers: Record<string, ChoiceAnswer> = {};
	const requests = buildShortlistRequests(state, pool);
	let inputTokens = 0;
	for (const request of requests)
	{
		const result = await client.run(request);
		inputTokens += result.usage.input_tokens;
		for (const [id, answer] of Object.entries(result.answers))
		{
			if (answer.type === "choice")
			{
				choiceAnswers[id] = answer;
			}
		}
	}
	return {
		value: selectShortlist(pool, choiceAnswers),
		requests: requests.length,
		inputTokens,
	};
}

/** Pass 2: one `noul` per shortlisted label on `verifier`; no request when the shortlist is empty. */
export async function runVerify(
	client: ClefClient,
	shortlist: readonly ShortlistEntry[],
	state: ClefState,
	verifier: ClefModel,
): Promise<PassResult<LabelSuggestion[]>>
{
	if (shortlist.length === 0)
	{
		return {
			value: [],
			requests: 0,
			inputTokens: 0,
		};
	}
	const result = await client.run(buildVerifyRequest(state, shortlist, verifier));
	const value: LabelSuggestion[] = [];
	for (const {label} of shortlist)
	{
		const answer = result.answers[label.optionId];
		if (answer?.type === "noul")
		{
			value.push(
				{
					label: label.label,
					kind: label.kind,
					source: verifier,
					score: answer.noul,
				},
			);
		}
	}
	return {
		value,
		requests: 1,
		inputTokens: result.usage.input_tokens,
	};
}

/**
 * Runs both Clef passes for one entry: the pass 1 `choice` shortlist on Clef-flash, then the pass 2 `noul` verify on
 * `verifier`. Returns the shortlist scores (`clef-flash-shortlist`) and the verify scores (`verifier`) to persist.
 */
export async function scoreEntry(
	client: ClefClient,
	pool: readonly PoolLabel[],
	state: ClefState,
	verifier: ClefModel,
): Promise<LabelSuggestion[]>
{
	const {value: shortlist} = await runShortlist(client, pool, state);
	const {value: verified} = await runVerify(client, shortlist, state, verifier);
	return [
		...shortlist.map(({label, score}): LabelSuggestion => (
		{
			label: label.label,
			kind: label.kind,
			source: "clef-flash-shortlist",
			score,
		})),
		...verified,
	];
}
