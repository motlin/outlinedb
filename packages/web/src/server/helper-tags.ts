import {stripHtmlTags} from "@outlinedb/shared/html";
import {findTags} from "@outlinedb/shared/tags";

export interface HelperTags
{
	hashTags: string[];
	atTags: string[];
}

const HELPER_TAG_LIMIT = 1000;

interface TagTally
{
	/** Casing of the first occurrence. */
	display: string;
	count: number;
}

interface TagRow
{
	name: string | null;
	note: string | null;
}

// Snapshot rows are shared across requests, so each row's tags are found once.
const tagCache = new WeakMap<TagRow, string[]>();

function rowTags(row: TagRow): string[]
{
	let tags = tagCache.get(row);
	if (tags === undefined)
	{
		tags = [row.name, row.note].flatMap((html) => findTags(stripHtmlTags(html)).map(({tag}) => tag));
		tagCache.set(row, tags);
	}
	return tags;
}

function rank(tallies: Iterable<TagTally>): string[]
{
	return [...tallies]
		.toSorted((a, b) => b.count - a.count || a.display.toLowerCase().localeCompare(b.display.toLowerCase()))
		.slice(0, HELPER_TAG_LIMIT)
		.map((tally) => tally.display);
}

/**
 * Upstream's search helper sections: the `#tag` and `@tag` tokens in the plain-text name and note of every row,
 * counted case-insensitively and ranked by count descending, then case-insensitive alphabetical, keeping the
 * casing of each tag's first occurrence; at most 1000 per list.
 */
export function collectHelperTags(rows: Iterable<TagRow>): HelperTags
{
	const hash = new Map<string, TagTally>();
	const at = new Map<string, TagTally>();
	for (const row of rows)
	{
		for (const tag of rowTags(row))
		{
			const tallies = tag.startsWith("#") ? hash : at;
			const key = tag.toLowerCase();
			const tally = tallies.get(key);
			if (tally === undefined)
			{
				tallies.set(
					key,
					{
						display: tag,
						count: 1,
					},
				);
			}
			else
			{
				tally.count += 1;
			}
		}
	}
	return {
		hashTags: rank(hash.values()),
		atTags: rank(at.values()),
	};
}
