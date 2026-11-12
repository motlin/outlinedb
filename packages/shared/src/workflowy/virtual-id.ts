/**
 * Upstream's per-mirror "virtual" item ids. A row met inside mirror root R is an instance of the original's row, with
 * id `virtual_<childId>_<R>[_<path>]` (`n91`), where `path` is the chunks of the rows between R and it. Its short form
 * is `v_<child12>_<R12>[_<path>]` (`UK.toShort`), used in URLs, and its expansion key on the account is
 * `v_<child4><R4><path>` (`YA`).
 */
const SHORT_LENGTH = 12;
const KEY_CHUNK = 4;
const VIRTUAL_PREFIX = "virtual_";

export interface VirtualRow
{
	childId: string;
	mirrorRootId: string;
	path: string;
}

export function virtualId({childId, mirrorRootId, path}: VirtualRow): string
{
	return `${VIRTUAL_PREFIX}${childId}_${mirrorRootId}${path === "" ? "" : `_${path}`}`;
}

export function virtualShortId({childId, mirrorRootId, path}: VirtualRow): string
{
	return `v_${childId.slice(-SHORT_LENGTH)}_${mirrorRootId.slice(-SHORT_LENGTH)}${path === "" ? "" : `_${path}`}`;
}

export interface VirtualShortParts
{
	nodeShortId: string;
	mirrorShortId: string;
	path: string;
}

const SHORT_PATTERN = /^v_([0-9a-f]{12})_([0-9a-f]{12})(?:_([^_/?#]+))?$/u;

/** The parts of a `v_<child12>_<mirror12>[_<path>]` location id, or null for any other id. */
export function parseVirtualShortId(value: string): VirtualShortParts | null
{
	const match = SHORT_PATTERN.exec(value);
	return match === null
		? null
		:
			{
				nodeShortId: match[1] ?? "",
				mirrorShortId: match[2] ?? "",
				path: match[3] ?? "",
			};
}

const VIRTUAL_PATTERN = /^virtual_([^_]+)_([^_]+)(?:_(.+))?$/u;

/** The row a `virtual_…` id names, or null for any other id. */
export function parseVirtualId(value: string): VirtualRow | null
{
	const match = VIRTUAL_PATTERN.exec(value);
	return match === null
		? null
		:
			{
				childId: match[1] ?? "",
				mirrorRootId: match[2] ?? "",
				path: match[3] ?? "",
			};
}

/** The key the account stores a row's expansion under: `v_<child4><R4><path>` for an instance, else the first 8 chars. */
export function upstreamExpansionKey(id: string): string
{
	const row = parseVirtualId(id);
	if (row === null)
	{
		return id.slice(0, 2 * KEY_CHUNK);
	}
	return `v_${row.childId.slice(0, KEY_CHUNK)}${row.mirrorRootId.slice(0, KEY_CHUNK)}${row.path}`;
}
