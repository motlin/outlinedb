import {z} from "zod";
import {locationUrl, parseLocationHash, shortId} from "./location.js";

/** The hash fragment key upstream stores the pane workspace under (`#/<id>?panes=v2.…`). */
export const PANES_FRAGMENT = "panes";
/** Upstream's `localStorage` key for the active pane. */
export const PANE_RUNTIME_KEY = "pane-workspace-runtime:v2";
/** Upstream's per-pane `localStorage` key prefix for a pane's width: `pane-width:<id>`. */
const PANE_WIDTH_KEY_PREFIX = "pane-width:";

const VERSION_PREFIX = "v2.";
const MAX_LENGTH = 65_536;
const ITEM_TREE = "item-tree";
/** Upstream's item-tree urlState names Home by `WF.Item.root.id`. */
const HOME_ID = "None";
const PANE_ID = /^[A-Za-z0-9_-]{11}$/u;

/** `[[mainId, "item-tree"], [paneId, type, urlState], …]`. */
export type PanesState = [string, string, ...unknown[]][];

export type DecodedPanes =
	|
	  {
			kind: "absent";
	  }
	|
	  {
			kind: "invalid";
	  }
	|
	  {
			kind: "valid";
			state: PanesState;
	  };

/** One secondary item-tree pane as the URL names it: its id, zoom (full or short id; null is Home) and search query. */
export interface PaneUrl
{
	paneId: string;
	location: string | null;
	query?: string | null;
}

/** The pane workspace as `panes=v2.` names it: the main pane's id, then each secondary pane left to right. */
export interface WorkspaceUrl
{
	mainPaneId: string;
	panes: PaneUrl[];
}

function toBase64url(bytes: Uint8Array): string
{
	let binary = "";
	for (const byte of bytes)
	{
		binary += String.fromCodePoint(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Upstream `$92`: `v2.` + base64url of the UTF-8 JSON; undefined past the 65536-character cap. */
export function encodePanes(state: readonly unknown[]): string | undefined
{
	const encoded = VERSION_PREFIX + toBase64url(new TextEncoder().encode(JSON.stringify(state)));
	return encoded.length > MAX_LENGTH ? undefined : encoded;
}

function parsePayload(payload: string): unknown
{
	const base64 = payload
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
	const binary = atob(base64);
	const bytes = Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
	return JSON.parse(
		new TextDecoder(
			"utf-8",
			{
				fatal: true,
			},
		).decode(bytes),
	) as unknown;
}

/** Upstream `q92`: decode and validate a `panes` fragment value. */
export function decodePanes(value: string | null | undefined): DecodedPanes
{
	if (value === null || value === undefined)
	{
		return {
			kind: "absent",
		};
	}
	const payload = value.slice(VERSION_PREFIX.length);
	if (
		value.length > MAX_LENGTH ||
		!value.startsWith(VERSION_PREFIX) ||
		payload === "" ||
		!/^[A-Za-z0-9_-]+$/u.test(payload) ||
		payload.length % 4 === 1
	)
	{
		return {
			kind: "invalid",
		};
	}
	let parsed: unknown;
	try
	{
		parsed = parsePayload(payload);
	}
	catch
	{
		return {
			kind: "invalid",
		};
	}
	if (!Array.isArray(parsed) || parsed.length === 0)
	{
		return {
			kind: "invalid",
		};
	}
	const [main, ...rest] = parsed as unknown[];
	if (!Array.isArray(main) || main.length !== 2)
	{
		return {
			kind: "invalid",
		};
	}
	const [mainId, mainType] = main as unknown[];
	if (typeof mainId !== "string" || !PANE_ID.test(mainId) || mainType !== ITEM_TREE)
	{
		return {
			kind: "invalid",
		};
	}
	const seen = new Set([mainId]);
	const state: PanesState = [[mainId, ITEM_TREE]];
	for (const entry of rest)
	{
		if (!Array.isArray(entry) || entry.length !== 3)
		{
			return {
				kind: "invalid",
			};
		}
		const [id, type, urlState] = entry as unknown[];
		if (typeof id !== "string" || !PANE_ID.test(id) || seen.has(id) || typeof type !== "string" || type === "")
		{
			return {
				kind: "invalid",
			};
		}
		seen.add(id);
		state.push([id, type, urlState]);
	}
	return {
		kind: "valid",
		state,
	};
}

function paneQuery(query: string | null | undefined): string | null
{
	return query === undefined || query === "" ? null : query;
}

/** A workspace read from the URL: every pane's query is present (null for none). */
export interface DecodedWorkspace
{
	mainPaneId: string;
	panes: (PaneUrl &
	{
		query: string | null;
	})[];
}

/** The item-tree pane's `toUrl`: `[shortId]` or `[shortId, searchQuery]`, Home as `None`. */
function paneUrlState({location, query}: PaneUrl): string[]
{
	const zoom = location === null ? HOME_ID : shortId(location);
	const search = paneQuery(query);
	return search === null ? [zoom] : [zoom, search];
}

/** Upstream's snapshot encoding: the main pane, then each item-tree pane with its urlState. */
export function encodeWorkspace({mainPaneId, panes}: WorkspaceUrl): string | undefined
{
	return encodePanes([[mainPaneId, ITEM_TREE], ...panes.map((pane) => [pane.paneId, ITEM_TREE, paneUrlState(pane)])]);
}

/** The item-tree pane's `fromUrl`; null for any other type or a malformed urlState. */
function decodePane([paneId, type, urlState]: PanesState[number]):
	| (PaneUrl &
	  {
			query: string | null;
	  })
	| null
{
	if (type !== ITEM_TREE || !Array.isArray(urlState))
	{
		return null;
	}
	const [id, query = null] = urlState as unknown[];
	if (typeof id !== "string" || id === "" || (query !== null && typeof query !== "string"))
	{
		return null;
	}
	return {
		paneId,
		location: id === HOME_ID ? null : id,
		query,
	};
}

/**
 * The workspace a `panes` value names; null when absent, malformed, naming no extra pane, or naming a pane this app
 * cannot render (upstream's `applySnapshot` rejects the whole snapshot then).
 */
export function decodeWorkspace(value: string | null | undefined): DecodedWorkspace | null
{
	const decoded = decodePanes(value);
	if (decoded.kind !== "valid")
	{
		return null;
	}
	const [main, ...rest] = decoded.state;
	if (main === undefined || rest.length === 0)
	{
		return null;
	}
	const panes = rest.map(decodePane);
	return panes.every((pane) => pane !== null)
		?
			{
				mainPaneId: main[0],
				panes,
			}
		: null;
}

/** The workspace as the URL should name it, from the store's panes and main URL id; null with no pane open. */
export function storeWorkspaceUrl(
	panes: readonly
	{
		id: string;
		zoomedId: string | null;
		query: string;
	}[],
	mainPaneUrlId: string | null,
): WorkspaceUrl | null
{
	return panes.length === 0 || mainPaneUrlId === null
		? null
		:
			{
				mainPaneId: mainPaneUrlId,
				panes: panes.map((pane) => (
				{
					paneId: pane.id,
					location: pane.zoomedId,
					query: paneQuery(pane.query),
				})),
			};
}

/**
 * The `panes` fragment naming the store's panes, empty with none. A main-pane navigation carries it so the pane sync
 * never has to replace the pushed URL a frame later.
 */
export function workspaceFragments(
	panes: readonly
	{
		id: string;
		zoomedId: string | null;
		query: string;
	}[],
	mainPaneUrlId: string | null,
): Record<string, string>
{
	const store = storeWorkspaceUrl(panes, mainPaneUrlId);
	const value = store === null ? undefined : encodeWorkspace(store);
	return value === undefined
		? {}
		:
			{
				[PANES_FRAGMENT]: value,
			};
}

/** The URL for `hash` with its `panes` param set to `value`, or dropped for null. */
export function withPanesFragment(hash: string, value: string | null): string
{
	const {id, query, fragments} = parseLocationHash(hash);
	const {[PANES_FRAGMENT]: _dropped, ...rest} = fragments;
	return locationUrl(
		{
			id,
			query,
			fragments:
				value === null
					? rest
					:
						{
							...rest,
							[PANES_FRAGMENT]: value,
						},
		},
	);
}

function shortZoom(location: string | null): string | null
{
	return location === null ? null : shortId(location);
}

function samePane(a: PaneUrl, b: PaneUrl): boolean
{
	return (
		a.paneId === b.paneId &&
		shortZoom(a.location) === shortZoom(b.location) &&
		paneQuery(a.query) === paneQuery(b.query)
	);
}

/** Upstream's `snapshotEquals`: the same pane ids in order, each with the same zoom by short id and search query. */
export function sameWorkspace(a: WorkspaceUrl | null, b: WorkspaceUrl | null): boolean
{
	if (a === null || b === null)
	{
		return a === b;
	}
	return (
		a.mainPaneId === b.mainPaneId &&
		a.panes.length === b.panes.length &&
		a.panes.every((pane, index) =>
		{
			const other = b.panes[index];
			return other !== undefined && samePane(pane, other);
		})
	);
}

export type PaneUrlAction = "none" | "apply" | "close" | "restore-url";

/**
 * After a location change: a URL naming panes wins (reload, Back/Forward, a
 * pasted link). A URL without them closes the panes only on browser Back/Forward;
 * an in-app navigation that dropped the param gets the open panes written back.
 */
export function reconcilePaneUrl({
	url,
	store,
	isPop,
}: {
	url: WorkspaceUrl | null;
	store: WorkspaceUrl | null;
	isPop: boolean;
}): PaneUrlAction
{
	if (sameWorkspace(url, store))
	{
		return "none";
	}
	if (url !== null)
	{
		return "apply";
	}
	return isPop ? "close" : "restore-url";
}

/** Upstream `createPaneId`: 8 random bytes as 11 base64url characters. */
export function createPaneId(
	randomBytes: () => Uint8Array = () => globalThis.crypto.getRandomValues(new Uint8Array(8)),
): string
{
	return toBase64url(randomBytes());
}

export function paneWidthKey(paneId: string): string
{
	return `${PANE_WIDTH_KEY_PREFIX}${paneId}`;
}

/** What a runtime persistence pass changes in `localStorage`: the entries to write and the keys to remove. */
export interface PaneStorageUpdate
{
	set: Record<string, string>;
	remove: string[];
}

/**
 * Upstream `startRuntimePersistence`: `pane-workspace-runtime:v2` holds the active pane's URL id, and each pane keeps
 * `pane-width:<id>` = `{type, width}` (only for a finite positive width). `ids` are the panes' URL ids, main first,
 * with `widths` in the same order. A pane in `previousIds` that is gone loses its width key; with no pane left every
 * key goes.
 */
export function paneStorageUpdate({
	previousIds,
	ids,
	activePaneId,
	widths,
}: {
	previousIds: readonly string[];
	ids: readonly string[];
	activePaneId: string;
	widths: readonly number[];
}): PaneStorageUpdate
{
	const gone = previousIds.filter((id) => !ids.includes(id)).map(paneWidthKey);
	if (ids.length === 0)
	{
		return {
			set: {},
			remove: [PANE_RUNTIME_KEY, ...gone],
		};
	}
	const set: Record<string, string> =
	{
		[PANE_RUNTIME_KEY]: JSON.stringify(
			{
				activePaneId,
			},
		),
	};
	const remove = [...gone];
	for (const [index, id] of ids.entries())
	{
		const width = widths[index];
		if (width !== undefined && Number.isFinite(width) && width > 0)
		{
			set[paneWidthKey(id)] = JSON.stringify(
				{
					type: ITEM_TREE,
					width,
				},
			);
		}
		else
		{
			remove.push(paneWidthKey(id));
		}
	}
	return {
		set,
		remove,
	};
}

/** Write a `paneStorageUpdate` to `storage`. */
export function applyPaneStorageUpdate(
	storage: Pick<Storage, "setItem" | "removeItem">,
	update: PaneStorageUpdate,
): void
{
	for (const [key, value] of Object.entries(update.set))
	{
		storage.setItem(key, value);
	}
	for (const key of update.remove)
	{
		storage.removeItem(key);
	}
}

const runtimeStateSchema = z.object(
	{
		activePaneId: z.string(),
	},
);

const paneWidthSchema = z.object(
	{
		type: z.string(),
		width: z.number(),
	},
);

/** What `restoreRuntimeState` takes from the record: the active pane's URL id. */
export interface RestoredRuntime
{
	activePaneId: string;
}

/**
 * Upstream `restoreRuntimeState`: the stored active pane, only when it is one of the URL's panes (`paneIds`, main
 * first); null otherwise.
 */
export function restoredRuntime(stored: string | null, paneIds: readonly string[]): RestoredRuntime | null
{
	try
	{
		const parsed = runtimeStateSchema.safeParse(JSON.parse(stored ?? "null"));
		return parsed.success && paneIds.includes(parsed.data.activePaneId)
			?
				{
					activePaneId: parsed.data.activePaneId,
				}
			: null;
	}
	catch
	{
		return null;
	}
}

/** Upstream's stored `pane-width:<id>`: its width when the type is an item-tree and the width is finite and positive. */
export function restoredPaneWidth(stored: string | null): number | null
{
	try
	{
		const parsed = paneWidthSchema.safeParse(JSON.parse(stored ?? "null"));
		return parsed.success &&
			parsed.data.type === ITEM_TREE &&
			Number.isFinite(parsed.data.width) &&
			parsed.data.width > 0
			? parsed.data.width
			: null;
	}
	catch
	{
		return null;
	}
}
