/**
 * Pure starring model shared by the web client and the server's /api/v1/stars mapping.
 * Mirrors upstream Workflowy's starred-page/search model: a star is a location
 * (a node, or Home when nodeId is null, optionally with a search query).
 */

export interface StarredLocation
{
	nodeId: string | null;
	query: string | null;
}

export type Star = StarredLocation &
{
	key: string;
	name: string | null;
	position: number;
};

export type NameText = (nodeId: string | null) => string;

const HOME_KEY = "None";

/** Upstream `Lo`: `(nodeId ?? "None") + (query ? "_" + query : "")`. */
export function locationKey({nodeId, query}: StarredLocation): string
{
	return (nodeId ?? HOME_KEY) + (query ? `_${query}` : "");
}

/** Inverse of locationKey; splits at the first underscore so queries may contain underscores. */
export function parseLocationKey(key: string): StarredLocation
{
	const separator = key.indexOf("_");
	const rawNodeId = separator === -1 ? key : key.slice(0, separator);
	const rawQuery = separator === -1 ? "" : key.slice(separator + 1);
	return {
		nodeId: rawNodeId === HOME_KEY ? null : rawNodeId,
		query: rawQuery === "" ? null : rawQuery,
	};
}

/** Recency and DOM key; Home is `None/None/`. */
export function uniqueId({nodeId, query}: StarredLocation): string
{
	return `None/${nodeId ?? HOME_KEY}/${query ?? ""}`;
}

/** Searches first by query, then pages by their node's name. */
export function defaultOrder(stars: readonly Star[], nameText: NameText): Star[]
{
	const searches = stars.filter((s) => s.query).toSorted((x, y) => (x.query ?? "").localeCompare(y.query ?? ""));
	const pages = stars
		.filter((s) => !s.query)
		.toSorted((x, y) => nameText(x.nodeId).localeCompare(nameText(y.nodeId)));
	return [...searches, ...pages];
}

/** Optimistic add/remove for the client cache. `value` is whether the location is starred afterwards. */
export function applyToggle(
	stars: readonly Star[],
	loc: StarredLocation,
	force?: boolean,
):
{
	stars: readonly Star[];
	value: boolean;
}
{
	const key = locationKey(loc);
	const isStarred = stars.some((s) => s.key === key);
	const value = force ?? !isStarred;
	if (value === isStarred)
	{
		return {
			stars,
			value,
		};
	}
	if (!value)
	{
		return {
			stars: stars.filter((s) => s.key !== key),
			value,
		};
	}
	const position = Math.max(-1, ...stars.map((s) => s.position)) + 1;
	const added: Star =
	{
		key,
		nodeId: loc.nodeId,
		query: loc.query === "" ? null : loc.query,
		name: null,
		position,
	};
	return {
		stars: [...stars, added],
		value,
	};
}

/** Body of `PUT /api/v1/stars/order`: move srcKey before or after targetKey. Unknown keys return the input. */
export function moveKey(keys: readonly string[], srcKey: string, targetKey: string, after: boolean): readonly string[]
{
	if (srcKey === targetKey || !keys.includes(srcKey) || !keys.includes(targetKey))
	{
		return keys;
	}
	const without = keys.filter((k) => k !== srcKey);
	const targetIndex = without.indexOf(targetKey) + (after ? 1 : 0);
	return [...without.slice(0, targetIndex), srcKey, ...without.slice(targetIndex)];
}

/** Sorted by lastViewed desc; ties and never-viewed by uniqueId asc. */
export function mostRecent(stars: readonly Star[], lastViewed: Readonly<Record<string, number>>): Star[]
{
	return stars
		.map((s) => (
		{
			s,
			id: uniqueId(s),
		}))
		.toSorted((x, y) =>
		{
			const diff = (lastViewed[y.id] ?? -Infinity) - (lastViewed[x.id] ?? -Infinity);
			if (diff !== 0 && !Number.isNaN(diff))
			{
				return diff;
			}
			return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
		})
		.map(({s}) => s);
}

/** Display label: custom name, then query, then the node's name (Home for the root). */
export function label(star: Star, nameText: NameText): string
{
	if (star.name !== null && star.name !== "")
	{
		return star.name;
	}
	if (star.query !== null && star.query !== "")
	{
		return star.query;
	}
	return star.nodeId === null ? "Home" : nameText(star.nodeId);
}

/** The location ⇧⌘8 stars: the page plus the committed search query (Home included); an empty query is none. */
export function starCurrentLocation({
	zoomedId,
	query,
}: {
	zoomedId: string | null;
	query: string | null;
}): StarredLocation
{
	return {
		nodeId: zoomedId,
		query: query === "" ? null : query,
	};
}

/** Upstream stamps a star's last-viewed time only when navigation reaches a different location. */
export function shouldRecordView(previous: StarredLocation | null, next: StarredLocation): boolean
{
	return previous === null || locationKey(previous) !== locationKey(next);
}
