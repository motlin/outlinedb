import {CacheService} from "@outlinedb/shared/cache";
import type * as schema from "@outlinedb/shared/db";
import {stripHtmlTags} from "@outlinedb/shared/html";
import type {BetterSQLite3Database} from "drizzle-orm/better-sqlite3";

export interface BrokenInboxLink
{
	linkId: string;
	name: string;
	shortId: string;
}

const WORKFLOWY_LINK = /<a href="https:\/\/workflowy\.com\/#\/([a-f0-9]{12})">/iu;

/**
 * Resolve each Metadata > 📥 Inboxes link to its target node. A link whose
 * target is missing from the cache is reported as broken rather than silently
 * falling back, because a stale link leaves the real inbox untriaged.
 */
export function resolveInboxLinks(
	database: BetterSQLite3Database<typeof schema>,
	links:
	{
		id: string;
		name: string | null;
	}[],
):
{
	targets: Map<string, string>;
	broken: BrokenInboxLink[];
}
{
	const cache = new CacheService(database);
	const linkShortIds = links.flatMap((link) =>
	{
		const shortId = link.name?.match(WORKFLOWY_LINK)?.[1];
		return shortId
			? [
					{
						link,
						shortId,
					},
				]
			: [];
	});
	const uuids =
		linkShortIds.length > 0
			? cache.resolveMultipleShortIds(linkShortIds.map(({shortId}) => shortId))
			: new Map<string, string>();

	const targets = new Map<string, string>();
	const broken: BrokenInboxLink[] = [];
	for (const {link, shortId} of linkShortIds)
	{
		const uuid = uuids.get(shortId);
		const target = uuid ? cache.getNode(uuid) : null;
		if (target)
		{
			targets.set(link.id, target.id);
		}
		else
		{
			broken.push(
				{
					linkId: link.id,
					name: stripHtmlTags(link.name ?? "").trim(),
					shortId,
				},
			);
		}
	}
	return {
		targets,
		broken,
	};
}

function normalizeTitle(name: string): string
{
	return stripHtmlTags(name).trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

/** Group open sibling items whose visible titles match; each group is a probable duplicate. */
export function findSameTitleSiblings(
	items:
	{
		id: string;
		name: string;
		completed?: boolean;
	}[],
):
{
	title: string;
	ids: string[];
}[]
{
	const groups = new Map<
		string,
		{
			title: string;
			ids: string[];
		}
	>();
	for (const item of items)
	{
		const key = normalizeTitle(item.name);
		if (item.completed || key === "")
		{
			continue;
		}
		const group = groups.get(key);
		if (group)
		{
			group.ids.push(item.id);
		}
		else
		{
			groups.set(
				key,
				{
					title: stripHtmlTags(item.name).trim(),
					ids: [item.id],
				},
			);
		}
	}
	return [...groups.values()].filter((group) => group.ids.length > 1);
}
