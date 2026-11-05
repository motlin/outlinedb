import {ancestorChain} from "@workflowy/shared/cache";
import type {CacheService} from "@workflowy/shared/cache";
import {dayNameDate} from "@workflowy/shared/calendar-lookup";
import {stripHtmlTags} from "@workflowy/shared/html";
import {findTags} from "@workflowy/shared/tags";
import {buildShortlistRequests, buildVerifyRequest, selectShortlist} from "./clef-requests.js";
import type {ChoiceAnswer, ClefClient, ClefModel, ClefState} from "./clef-requests.js";
import type {PoolLabel} from "./label-pool.js";
import type {LabelSuggestion} from "./label-suggestions.js";

/**
 * The entries under `rootId`, in outline order: its children, with each calendar day (a date-only `<time>` name)
 * replaced by the day's children. A month yields its journal entries; the Inbox yields its items.
 */
export function scopeEntries(cache: CacheService, rootId: string): string[] {
	return cache
		.getChildren(rootId)
		.flatMap((child) =>
			dayNameDate(child.name) === undefined ? [child.id] : cache.getChildren(child.id).map(({id}) => id),
		);
}

/** What Clef reads about an entry, and the `@mentions`/`#tags` it already carries. */
export function entryState(cache: CacheService, nodeId: string): {state: ClefState; labels: string[]} {
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
	return {state: {date, parent, entry}, labels: findTags(entry).map(({tag}) => tag)};
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
): Promise<LabelSuggestion[]> {
	const choiceAnswers: Record<string, ChoiceAnswer> = {};
	for (const request of buildShortlistRequests(state, pool)) {
		const result = await client.run(request);
		for (const [id, answer] of Object.entries(result.answers)) {
			if (answer.type === "choice") {
				choiceAnswers[id] = answer;
			}
		}
	}
	const shortlist = selectShortlist(pool, choiceAnswers);
	const suggestions: LabelSuggestion[] = shortlist.map(({label, score}) => ({
		label: label.label,
		kind: label.kind,
		source: "clef-flash-shortlist",
		score,
	}));
	if (shortlist.length === 0) {
		return suggestions;
	}

	const result = await client.run(buildVerifyRequest(state, shortlist, verifier));
	for (const {label} of shortlist) {
		const answer = result.answers[label.optionId];
		if (answer?.type === "noul") {
			suggestions.push({label: label.label, kind: label.kind, source: verifier, score: answer.noul});
		}
	}
	return suggestions;
}
