import {parseVirtualShortId, virtualShortId} from "@outlinedb/shared/workflowy";
import type {MirrorInstance} from "../mirror-path.js";

/** Upstream item URLs use the last 12 characters of the uuid. */
const SHORT_ID_LENGTH = 12;

export interface Location {
	id: string | null;
	query: string | null;
	fragments: Record<string, string>;
}

export interface LocationInput {
	id: string | null;
	/** Where the row sits inside a mirror: the location is its virtual `v_…` id. */
	instance?: MirrorInstance | null;
	query?: string | null;
	fragments?: Record<string, string>;
}

/** The last 12 characters of a uuid; a virtual `v_…` location id is already short and stays whole. */
export function shortId(id: string): string {
	return parseVirtualShortId(id) === null ? id.slice(-SHORT_ID_LENGTH) : id;
}

/** Home is `/`; an item is `/#/<shortId>`; params follow `?` as `q=<query>` then fragments joined by `&`. */
export function locationUrl({id, instance = null, query, fragments = {}}: LocationInput): string {
	const params = [
		...(query ? [`q=${encodeURIComponent(query)}`] : []),
		...Object.entries(fragments).map(([key, value]) =>
			value === "" ? encodeURIComponent(key) : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
		),
	];
	const path =
		id === null
			? ""
			: `/${instance === null ? shortId(id) : virtualShortId({childId: id, mirrorRootId: instance.rootId, path: instance.path})}`;
	if (params.length === 0) {
		return path === "" ? "/" : `/#${path}`;
	}
	return `/#${path}?${params.join("&")}`;
}

/** Mirrors upstream's parser: strip `#` or `#/`, keep the text between the first and second `?`, empty id means home. */
export function parseLocationHash(hash: string): Location {
	const body = hash.replace(/^#\/?/u, "");
	const [rawId = "", search = ""] = body.split("?");
	let query: string | null = null;
	const fragments: Record<string, string> = {};
	for (const [key, value] of new URLSearchParams(search)) {
		if (key === "q") {
			query = value === "" ? null : value;
		} else {
			fragments[key] = value;
		}
	}
	return {id: rawId === "" ? null : rawId, query, fragments};
}
