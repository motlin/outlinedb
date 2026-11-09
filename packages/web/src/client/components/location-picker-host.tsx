import {useQueries, useQueryClient} from "@tanstack/react-query";
import {stripHtmlTags} from "@outlinedb/shared/html";
import {useEffect, useMemo, useState} from "react";
import {useAiEmbeddingStage, usePreferences} from "../hooks/use-preferences.js";
import {fetchAncestors, useCreateNode} from "../hooks/use-nodes.js";
import {readLastViewed, useStarredLocations} from "../hooks/use-starred.js";
import {
	INITIAL_PICKER_STATE,
	ancestorCrumbs,
	buildPickerRows,
	reducePicker,
	resolveDefaultLocation,
	starredPickerIds,
} from "../location-picker-model.js";
import type {PickerEffect, PickerEvent, PickerResult, PickerState} from "../location-picker-model.js";
import {nodeKeys, readNode} from "../node-cache.js";
import {ensureNotesLocation, notesRootIdFor} from "../notes-location.js";
import type {LocationResponse, RelatedResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {createRecentLocations} from "../recent-locations.js";
import type {RecentLocations} from "../recent-locations.js";
import {useOutlineStore} from "../stores/outline.js";
import type {LocationPickerState} from "../stores/outline.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {LocationPicker} from "./location-picker.js";
import type {LocationCrumb} from "./location-picker.js";

/** One `/api/search/locations` hit: upstream's `<b><u>` word-start label and root-first ancestors without Home. */
type SearchHit = LocationResponse["results"][number];

const SEARCH_LIMIT = 50;
const EMPTY_HITS: readonly SearchHit[] = [];

let recents: RecentLocations | null = null;

/** Upstream's per-tab recent locations (sessionStorage `recentlySavedLocations`). */
function recentLocations(): RecentLocations {
	recents ??= createRecentLocations(sessionStorage, () => Date.now());
	return recents;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** A node name as upstream's `nameInPlainText`: markup stripped, then escaped as a text child. */
function plainLabel(name: string): string {
	return escapeHtml(stripHtmlTags(name));
}

/** Undebounced `/api/search/locations` hits for `query`, empty for an empty query; `pending` until the reply lands. */
function useSearchHits(
	query: string,
	starredIds: readonly string[],
	showCompleted: boolean,
): {hits: readonly SearchHit[]; pending: boolean} {
	const [found, setFound] = useState<{query: string; hits: readonly SearchHit[]}>({query: "", hits: []});
	useEffect(() => {
		if (query.trim() === "") {
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		// Upstream requests on every keystroke; a superseded query's request is aborted so a late reply cannot win.
		const controller = new AbortController();
		void (async () => {
			const response = await fetch("/api/search/locations", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({query, limit: SEARCH_LIMIT, starredIds, showCompleted}),
				signal: controller.signal,
			});
			if (!response.ok) {
				return;
			}
			const {results} = await readJson<LocationResponse>(response);
			if (!controller.signal.aborted) {
				setFound({query, hits: results});
			}
		})().catch((error: unknown) => {
			if (!controller.signal.aborted) {
				throw error;
			}
		});
		return () => {
			controller.abort();
		};
	}, [query, starredIds, showCompleted]);
	const landed = found.query === query;
	return {hits: landed ? found.hits : EMPTY_HITS, pending: !landed && query.trim() !== ""};
}

type RelatedHit = RelatedResponse["results"][number];

const RELATED_LIMIT = 8;
const RELATED_THRESHOLD = 0.6;
const EMPTY_RELATED: readonly RelatedHit[] = [];

/** Local extra: nodes semantically related to `nodeId` (`/api/related` link-targets), empty when unset or failed. */
function useRelatedHits(nodeId: string | undefined): readonly RelatedHit[] {
	const [found, setFound] = useState<{nodeId: string; hits: readonly RelatedHit[]}>({nodeId: "", hits: []});
	useEffect(() => {
		if (nodeId === undefined) {
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		const controller = new AbortController();
		void (async () => {
			const response = await fetch("/api/related", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({
					nodeId,
					type: "link-targets",
					limit: RELATED_LIMIT,
					threshold: RELATED_THRESHOLD,
				}),
			});
			if (!response.ok) {
				return;
			}
			const {results} = await readJson<RelatedResponse>(response);
			setFound({nodeId, hits: results});
		})().catch((error: unknown) => {
			if (!controller.signal.aborted) {
				throw error;
			}
		});
		return () => {
			controller.abort();
		};
	}, [nodeId]);
	return found.nodeId === nodeId ? found.hits : EMPTY_RELATED;
}

/** The stored view stamps, or none when storage is unavailable. */
function safeLastViewed(): Record<string, number> {
	try {
		return readLastViewed(globalThis.localStorage);
	} catch {
		return {};
	}
}

/** One open picker: its step machine, rows and the create-and-move sub-action. */
function LocationPickerSession({picker}: {picker: LocationPickerState}) {
	const queryClient = useQueryClient();
	const createNode = useCreateNode();
	const {preferences} = usePreferences();
	const stars = useStarredLocations();
	const closeLocationPicker = useOutlineStore((store) => store.closeLocationPicker);
	const [state, setState] = useState<PickerState>(INITIAL_PICKER_STATE);
	const {searcher, getFilter} = picker;
	const filter = getFilter?.() ?? null;
	const query = filter ?? state.query;
	// Keyed by content so a stars refetch that changes nothing does not re-issue the open search.
	const starredKey = starredPickerIds(stars, safeLastViewed()).join(",");
	const starredIds = useMemo(() => (starredKey === "" ? [] : starredKey.split(",")), [starredKey]);
	const showCompleted = useOutlineStore((store) => store.showCompleted);
	const {hits: fetchedHits, pending} = useSearchHits(searcher === undefined ? query : "", starredIds, showCompleted);
	const hits: readonly SearchHit[] =
		searcher === undefined
			? fetchedHits
			: (query === "" && !searcher.eager ? [] : searcher.search(query)).map(({id, labelHtml}) => ({
					id,
					labelHtml,
					ancestors: [],
				}));

	// Upstream gates its AI search on `ai.embeddingStatus`; ask for semantic neighbours only once it is ready.
	const aiReady = useAiEmbeddingStage() === "ready";
	const relatedHits = useRelatedHits(aiReady ? picker.relatedToId : undefined);

	const nameOf = (id: string): string =>
		readNode(queryClient, id)?.name ?? stars.find((star) => star.nodeId === id)?.name ?? "";
	const recentIds = recentLocations().ids();
	const exists = (id: string): boolean => readNode(queryClient, id) !== undefined;
	const recentExists = (id: string): boolean => exists(id) || stars.some((star) => star.nodeId === id);
	const defaultLocation = resolveDefaultLocation({
		recentIds,
		notesRootId: notesRootIdFor(preferences),
		exists: (id) => (recentIds.includes(id) ? recentExists(id) : exists(id)),
	});
	const results: PickerResult[] = hits.map(({id, labelHtml}) => ({id, labelHtml}));
	const listedIds = [...new Set([...recentIds, ...starredIds])];
	const chains = useQueries({
		queries: listedIds.map((id) => ({
			queryKey: nodeKeys.ancestors(id),
			queryFn: async () => fetchAncestors(id),
		})),
	});
	const crumbsById = new Map<string, readonly LocationCrumb[]>([
		...listedIds.map((id, index): [string, readonly LocationCrumb[]] => [
			id,
			ancestorCrumbs(chains[index]?.data ?? []),
		]),
		...relatedHits.map((hit): [string, readonly LocationCrumb[]] => [
			hit.id,
			hit.path.map((name, index) => ({id: `${hit.id}-${index}`, name})),
		]),
		...hits.map((hit): [string, readonly LocationCrumb[]] => [hit.id, hit.ancestors]),
	]);
	const rows = buildPickerRows({
		query,
		results,
		related: relatedHits.map((hit) => ({id: hit.id, labelHtml: plainLabel(hit.name ?? "") || "Untitled"})),
		eager: searcher?.eager,
		action: searcher?.action,
		subActionName: picker.subActionName,
		recentIds,
		starredIds,
		forItemId: picker.forItemId,
		expanded: state.expanded,
		step: state.step,
		pending,
		exists: recentExists,
		recentLabel: "create" in defaultLocation ? "Notes" : plainLabel(nameOf(defaultLocation.id)),
		labelOf: (id) => plainLabel(nameOf(id)),
	});

	const defaultTarget = async () =>
		"create" in defaultLocation ? ensureNotesLocation(queryClient) : defaultLocation.id;

	const subAction = async (parentId: string | undefined, name: string) => {
		const parent = parentId ?? (await defaultTarget());
		const createdId = crypto.randomUUID();
		await runInUndoBatch(captureOutlineView, () => {
			recentLocations().add(parent);
			createNode.mutate({id: createdId, parent_id: parent, name, index: 0});
		});
		closeLocationPicker({createdId});
	};

	const run = (effect: PickerEffect) => {
		if (effect.type === "close") {
			closeLocationPicker(undefined);
		} else if (effect.type === "action") {
			closeLocationPicker({id: effect.id});
		} else if (effect.type === "sub-action") {
			void subAction(effect.id, effect.name);
		}
	};

	const dispatch = (event: PickerEvent) => {
		const transition = reducePicker(state, event, rows);
		setState(transition.state);
		run(transition.effect);
	};

	const crumbsOf = (id: string): readonly LocationCrumb[] => crumbsById.get(id) ?? [];
	return (
		<LocationPicker
			position={[picker.anchor.x, picker.anchor.y]}
			step={state.step}
			headerText={picker.headerText}
			name={state.name}
			query={query}
			subActionName={picker.subActionName}
			hideInput={filter !== null}
			onQueryChange={(typed) => {
				dispatch({type: "query", query: typed});
			}}
			rows={rows}
			crumbsOf={crumbsOf}
			active={state.active}
			onSelect={(_row, index) => {
				dispatch({type: "select", index});
			}}
			onEscape={() => {
				dispatch({type: "key", key: "Escape"});
			}}
			onFocusLeave={() => {
				dispatch({type: "focus-leave"});
			}}
		/>
	);
}

/** The one inline location picker root, shown wherever `openLocationPicker` opened it. */
export function LocationPickerHost() {
	const picker = useOutlineStore((state) => state.locationPicker);
	if (picker === null) {
		return null;
	}
	return <LocationPickerSession key={`${picker.forItemId}:${picker.anchor.x}:${picker.anchor.y}`} picker={picker} />;
}
