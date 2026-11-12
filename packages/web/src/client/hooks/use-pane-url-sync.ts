import {useQueries} from "@tanstack/react-query";
import {useEffect, useRef} from "react";
import {z} from "zod";
import {NavigationType, useLocation, useNavigate, useNavigationType} from "react-router-dom";
import {parseLocationHash} from "../location.js";
import {RESOLVED_ID_STALE_TIME, nodeKeys} from "../node-cache.js";
import
{
	PANE_RUNTIME_KEY,
	PANES_FRAGMENT,
	applyPaneStorageUpdate,
	decodeWorkspace,
	encodeWorkspace,
	paneStorageUpdate,
	paneWidthKey,
	reconcilePaneUrl,
	restoredPaneWidth,
	restoredRuntime,
	sameWorkspace,
	storeWorkspaceUrl,
	withPanesFragment,
} from "../pane-url.js";
import {useOutlineStore, workspaceRuntimeState} from "../stores/outline.js";

/** `resolvedKey`'s entries: a pane location and the full id it resolved to (null when it names no node). */
const resolvedEntries = z.array(z.tuple([z.string(), z.string().nullable()]));

function readStorage(key: string): string | null
{
	try
	{
		return localStorage.getItem(key);
	}
	catch
	{
		return null;
	}
}

/**
 * Keep the open panes and the URL's `panes=v2.` param in step, and mirror the
 * workspace into `pane-workspace-runtime:v2` and `pane-width:<id>`. A URL naming panes opens, re-zooms
 * or drops them (reload, Back/Forward); a pane change pushes a new URL; closing
 * the last pane drops the param. Mount once (the outline route owns it).
 */
export function usePaneUrlSync(resolveId: (locationId: string) => Promise<string | null>): void
{
	const location = useLocation();
	const navigate = useNavigate();
	const isPop = useNavigationType() === NavigationType.Pop;
	const panes = useOutlineStore((state) => state.panes);
	const mainPaneUrlId = useOutlineStore((state) => state.mainPaneUrlId);
	const urlWorkspace = decodeWorkspace(parseLocationHash(location.hash).fragments[PANES_FRAGMENT]);
	const locations = [
		...new Set((urlWorkspace?.panes ?? []).flatMap((pane) => (pane.location === null ? [] : [pane.location]))),
	];
	// Each pane's location id resolved to a full id: undefined while loading, null when it names no node.
	const resolvedList = useQueries(
		{
			queries: locations.map((locationId) => (
			{
				queryKey: nodeKeys.resolvedId(locationId),
				queryFn: async () => resolveId(locationId),
				staleTime: RESOLVED_ID_STALE_TIME,
			})),
			combine: (results) =>
				results.map((result) => (result.data === null && result.isFetching ? undefined : result.data)),
		},
	);
	// The resolved locations as a string, so the URL effect re-runs only when one of them resolves.
	const resolvedKey = JSON.stringify(
		locations.flatMap((locationId, index) =>
		{
			const id = resolvedList[index];
			return id === undefined ? [] : [[locationId, id]];
		}),
	);

	// URL → store: runs on location changes only, so a pane change is never undone before its URL is pushed.
	useEffect(() =>
	{
		const url = decodeWorkspace(parseLocationHash(location.hash).fragments[PANES_FRAGMENT]);
		const state = useOutlineStore.getState();
		const store = storeWorkspaceUrl(state.panes, state.mainPaneUrlId);
		switch (
			reconcilePaneUrl(
				{
					url,
					store,
					isPop,
				},
			)
		)
		{
			case "apply":
			{
				if (url === null)
				{
					return;
				}
				const resolved = new Map(resolvedEntries.parse(JSON.parse(resolvedKey)));
				const zooms = url.panes.map((pane) => (pane.location === null ? null : resolved.get(pane.location)));
				if (zooms.includes(undefined))
				{
					return;
				}
				if (url.panes.some((pane, index) => pane.location !== null && zooms[index] === null))
				{
					state.closeAllPanes();
					void navigate(
						withPanesFragment(location.hash, null),
						{
							replace: true,
						},
					);
					return;
				}
				const paneIds = [url.mainPaneId, ...url.panes.map((pane) => pane.paneId)];
				const runtime = restoredRuntime(readStorage(PANE_RUNTIME_KEY), paneIds);
				const active = runtime?.activePaneId ?? null;
				state.restorePanes(
					{
						mainPaneId: url.mainPaneId,
						panes: url.panes.map((pane, index) => (
						{
							id: pane.paneId,
							zoomedId: zooms[index] ?? null,
							query: pane.query,
						})),
						activePaneId: active === url.mainPaneId ? null : active,
						widths: paneIds.map((id) => restoredPaneWidth(readStorage(paneWidthKey(id)))),
					},
				);
				return;
			}
			case "close":
			{
				state.closeAllPanes();
				return;
			}
			case "restore-url":
			{
				void navigate(
					withPanesFragment(location.hash, store === null ? null : (encodeWorkspace(store) ?? null)),
					{
						replace: true,
					},
				);
				return;
			}
			case "none":
			{
				return;
			}
		}
	}, [isPop, location.hash, navigate, resolvedKey]);

	// Store → URL: a pane opened, zoomed or closed in the app pushes a new history entry.
	const storeFragment = (() =>
	{
		const store = storeWorkspaceUrl(panes, mainPaneUrlId);
		return store === null ? null : (encodeWorkspace(store) ?? null);
	})();
	const previousFragment = useRef(storeFragment);
	useEffect(() =>
	{
		if (previousFragment.current === storeFragment)
		{
			return;
		}
		previousFragment.current = storeFragment;
		const {hash} = location;
		const url = decodeWorkspace(parseLocationHash(hash).fragments[PANES_FRAGMENT]);
		if (!sameWorkspace(url, decodeWorkspace(storeFragment)))
		{
			void navigate(withPanesFragment(hash, storeFragment));
		}
	}, [location, navigate, storeFragment]);

	// Upstream `startRuntimePersistence`: rewrite the keys when the panes, their widths or the active pane change, but
	// not while a divider drag is under way.
	useEffect(() =>
	{
		let writtenIds = workspaceRuntimeState(useOutlineStore.getState())?.ids ?? [];
		return useOutlineStore.subscribe((state, previous) =>
		{
			if (
				state.paneResizing ||
				(state.panes === previous.panes &&
					state.paneWidths === previous.paneWidths &&
					state.mainPaneUrlId === previous.mainPaneUrlId &&
					state.activePaneId === previous.activePaneId &&
					state.paneResizing === previous.paneResizing)
			)
			{
				return;
			}
			const record = workspaceRuntimeState(state);
			try
			{
				applyPaneStorageUpdate(
					localStorage,
					paneStorageUpdate(
						{
							previousIds: writtenIds,
							ids: record?.ids ?? [],
							activePaneId: record?.activePaneId ?? "",
							widths: record?.widths ?? [],
						},
					),
				);
			}
			catch
			{
				// Storage can be unavailable (private windows); the URL still carries the panes.
			}
			writtenIds = record?.ids ?? [];
		});
	}, []);
}
