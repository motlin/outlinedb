import {uuidToShortId} from "./constants.js";

const HREF_PATTERN = /href="([^"]*)"/giu;
const LINK_ID_PATTERN = /^(?:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}|[\da-f]{12})$/iu;

function decodeAttribute(value: string): string
{
	return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

/**
 * The linked id of one href, as upstream's `wr.targetID` reads it: the URL
 * parses, its hash is `#/<id>` with nothing after the id, and the host does
 * not matter. A relative href or a hash carrying `?q=` is no link.
 */
function linkedId(href: string): string | undefined
{
	let hash: string;
	try
	{
		hash = new URL(decodeAttribute(href)).hash;
	}
	catch
	{
		return undefined;
	}
	if (!hash.startsWith("#/"))
	{
		return undefined;
	}
	const id = hash.slice(2);
	return LINK_ID_PATTERN.test(id) ? id : undefined;
}

/** The short ids of the nodes `text` links to (its `<a href>`s ending in `#/<id>`), in order and deduplicated. */
export function internalLinkShortIds(text: string): string[]
{
	const shortIds = new Set<string>();
	for (const [, href] of text.matchAll(HREF_PATTERN))
	{
		const id = href === undefined ? undefined : linkedId(href);
		if (id !== undefined)
		{
			shortIds.add(uuidToShortId(id.toLowerCase()));
		}
	}
	return [...shortIds];
}

/** Whether `text` holds any internal link. */
export function hasInternalLink(text: string): boolean
{
	return internalLinkShortIds(text).length > 0;
}
