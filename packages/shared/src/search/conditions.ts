import {nodeContent, nodeMetadata} from "../db/schema.js";
import {notAMirror} from "../cache/mirror-text.js";
import {FAR_FUTURE_DATE} from "../temporal/constants.js";
import type {SQL} from "drizzle-orm";
import {and, eq, gte, isNotNull, isNull, like, not, or} from "drizzle-orm";
import type {ParsedQuery} from "./query-parser.js";

/**
 * Drizzle WHERE conditions derived from a {@link ParsedQuery}. Content conditions
 * apply to `node_content`; metadata conditions (completion, last-changed) require
 * joining `node_metadata`, which `needsMetadataJoin` signals.
 */
export interface SearchConditions
{
	contentConditions: SQL[];
	metadataConditions: SQL[];
	needsMetadataJoin: boolean;
}

/** Drizzle's and/or return undefined only for an empty argument list; every call here passes at least one. */
function defined(condition: SQL | undefined): SQL
{
	if (condition === undefined)
	{
		throw new Error("Expected a non-empty SQL condition list");
	}
	return condition;
}

/** Build SQL WHERE conditions for a parsed search query. */
export function buildSearchConditions(parsed: ParsedQuery): SearchConditions
{
	const contentConditions: SQL[] = [];
	const metadataConditions: SQL[] = [];

	// Always filter for current records, skipping mirrors: their stored text is
	// never meaningful, and the original matches instead.
	contentConditions.push(eq(nodeContent.systemTo, FAR_FUTURE_DATE), notAMirror(nodeContent.id));

	// Exact phrases - must appear in name or note
	for (const phrase of parsed.exactPhrases)
	{
		const pattern = `%${phrase}%`;
		contentConditions.push(defined(or(like(nodeContent.name, pattern), like(nodeContent.note, pattern))));
	}

	// Required terms (AND) - all must appear in name or note
	for (const term of parsed.requiredTerms)
	{
		const pattern = `%${term}%`;
		contentConditions.push(defined(or(like(nodeContent.name, pattern), like(nodeContent.note, pattern))));
	}

	// OR terms - at least one group must match, within each group all terms must match
	if (parsed.orTerms.length > 0)
	{
		const orConditions: SQL[] = [];
		for (const termGroup of parsed.orTerms)
		{
			const groupConditions: SQL[] = [];
			for (const term of termGroup)
			{
				const pattern = `%${term}%`;
				groupConditions.push(defined(or(like(nodeContent.name, pattern), like(nodeContent.note, pattern))));
			}
			if (groupConditions.length > 0)
			{
				orConditions.push(defined(and(...groupConditions)));
			}
		}
		if (orConditions.length > 0)
		{
			contentConditions.push(defined(or(...orConditions)));
		}
	}

	// Excluded terms - must NOT appear in name or note
	for (const term of parsed.excludedTerms)
	{
		const pattern = `%${term}%`;
		contentConditions.push(
			defined(
				and(
					or(isNull(nodeContent.name), not(like(nodeContent.name, pattern))),
					or(isNull(nodeContent.note), not(like(nodeContent.note, pattern))),
				),
			),
		);
	}

	// Completion filter - requires metadata join
	if (parsed.isComplete === true)
	{
		metadataConditions.push(isNotNull(nodeMetadata.completedAt));
	}
	else if (parsed.isComplete === false)
	{
		metadataConditions.push(isNull(nodeMetadata.completedAt));
	}

	// Date filter - last-changed:Nd means modifiedAt within last N days - requires metadata join
	if (parsed.lastChangedDays !== null)
	{
		const cutoffDate = new Date(Date.now() - parsed.lastChangedDays * 24 * 60 * 60 * 1000);
		metadataConditions.push(gte(nodeMetadata.modifiedAt, cutoffDate));
	}

	return {
		contentConditions,
		metadataConditions,
		needsMetadataJoin: metadataConditions.length > 0,
	};
}

/** Extract the terms used for relevance scoring from a parsed query. */
export function getScoringTerms(parsed: ParsedQuery): string[]
{
	const terms: string[] = [...parsed.exactPhrases, ...parsed.requiredTerms];
	for (const group of parsed.orTerms)
	{
		terms.push(...group);
	}
	return terms;
}
