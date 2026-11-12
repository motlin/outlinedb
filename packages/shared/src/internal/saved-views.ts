/**
 * Upstream's legacy star store: the account setting `saved_views_json`, a JSON list of
 * `{zoomedProject: {projectid, auxiliaryRootProjectId?}, searchQuery}`, one per starred
 * location. Upstream reads it while root metadata `starring.isSynced` is not true, and writes
 * it on every star toggle, sending the change to `/change_settings` as
 * `saved_views_json_delta` = `{added?, removed?}` (bundle `th4`/`eh4`).
 *
 * Unlike upstream's toggle, which removes a location already in the list even when starring,
 * {@link toggleSavedView} uses set semantics: starring adds a missing location, unstarring
 * removes a present one.
 */

import {z} from "zod";
import {locationKey, parseLocationKey, uniqueId} from "../starring.js";
import type {StarredLocation} from "../starring.js";
import type {StarNodes} from "./stars.js";

/** Upstream's id for Home and for the main tree's root. */
const NONE = "None";

const SavedViewSchema = z.looseObject(
	{
		zoomedProject: z.looseObject(
			{
				projectid: z.string().nullable(),
				auxiliaryRootProjectId: z.string().nullish(),
			},
		),
		searchQuery: z.string().nullish(),
	},
);

type SavedView = z.infer<typeof SavedViewSchema>;

interface SavedLocation extends StarredLocation
{
	treeRoot: string;
	/** The entry as stored (unknown keys kept), so untouched entries round-trip. */
	view: SavedView;
}

function parse(json: string | undefined): SavedLocation[]
{
	let raw: unknown;
	try
	{
		raw = JSON.parse(json ?? "[]");
	}
	catch
	{
		return [];
	}
	return (z.array(z.unknown()).safeParse(raw).data ?? []).flatMap((entry) =>
	{
		const parsed = SavedViewSchema.safeParse(entry);
		if (!parsed.success)
		{
			return [];
		}
		const {projectid, auxiliaryRootProjectId} = parsed.data.zoomedProject;
		const query = parsed.data.searchQuery ?? "";
		return [
			{
				nodeId: projectid === null || projectid === NONE ? null : projectid,
				query: query === "" ? null : query,
				treeRoot: auxiliaryRootProjectId ?? NONE,
				view: parsed.data,
			},
		];
	});
}

function sameLocation(
	x: StarredLocation &
	{
		treeRoot: string;
	},
	y: StarredLocation &
	{
		treeRoot: string;
	},
): boolean
{
	return x.treeRoot === y.treeRoot && uniqueId(x) === uniqueId(y);
}

/** Upstream `Ri1`: main-tree views whose node is gone are dropped, then views sort stably by their node's name. */
function validSorted(locations: SavedLocation[], nodes: StarNodes): SavedLocation[]
{
	return locations
		.filter((location) => location.treeRoot !== NONE || location.nodeId === null || nodes.exists(location.nodeId))
		.toSorted((x, y) => nodes.nameText(x.nodeId).localeCompare(nodes.nameText(y.nodeId)));
}

function toView({nodeId, query}: StarredLocation): SavedView
{
	return {
		zoomedProject:
		{
			projectid: nodeId ?? NONE,
			auxiliaryRootProjectId: NONE,
		},
		searchQuery: query ?? "",
	};
}

/** Upstream's legacy `makeMap`: location key -> tree root. A view without a tree root is in the main tree. */
export function savedViewsMap(json: string | undefined): Record<string, string>
{
	return Object.fromEntries(parse(json).map((location) => [locationKey(location), location.treeRoot]));
}

/** The saved views after starring or unstarring the main-tree location `key`, and the delta to POST. */
export function toggleSavedView(
	json: string | undefined,
	key: string,
	starred: boolean,
	nodes: StarNodes,
):
{
	json: string;
	delta: string;
}
{
	const location =
	{
		...parseLocationKey(key),
		treeRoot: NONE,
	};
	const current = validSorted(parse(json), nodes);
	const present = current.some((saved) => sameLocation(saved, location));
	if (present === starred)
	{
		return {
			json: json ?? "[]",
			delta: "{}",
		};
	}
	if (starred)
	{
		const view = toView(location);
		return {
			json: JSON.stringify([...current.map((saved) => saved.view), view]),
			delta: JSON.stringify(
				{
					added: [view],
				},
			),
		};
	}
	const removed = current.filter((saved) => sameLocation(saved, location));
	return {
		json: JSON.stringify(current.filter((saved) => !sameLocation(saved, location)).map((saved) => saved.view)),
		delta: JSON.stringify(
			{
				removed: removed.map((saved) => saved.view),
			},
		),
	};
}
