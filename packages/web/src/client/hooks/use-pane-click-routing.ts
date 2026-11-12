import {useQueryClient} from "@tanstack/react-query";
import {useEffect} from "react";
import {isMacPlatform} from "../editable-text-keys.js";
import {parseLocationHash} from "../location.js";
import {RESOLVED_ID_STALE_TIME, nodeKeys} from "../node-cache.js";
import {paneClickModifier} from "../pane-click-routing.js";
import {focusedPaneId} from "../left-bar-pane-nav.js";
import {openInPane} from "../pane-commands.js";
import {MAIN_PANE_ID, findPane} from "../pane-ids.js";
import {useOutlineStore} from "../stores/outline.js";
import {blurEditor, claim} from "./use-content-link-clicks.js";

const BULLET_SELECTOR = '[data-handbook="bullet.handle"][data-item-id]';

function paneIdOf(element: Element): string
{
	return element.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? MAIN_PANE_ID;
}

/**
 * Upstream's modifier-click pane routing (`bj4`): a document capture listener that claims clicks on bullets, header
 * breadcrumbs and left-bar rows. ⌥ or the platform's primary modifier opens the item in a pane (after its own pane for
 * a bullet or crumb, at the end for a left-bar row, keeping the row's search query); a plain left-bar click while side
 * panes are open navigates the focused or active pane instead of the main outline. Mount once (the app owns it).
 */
export function usePaneClickRouting(resolveId: (locationId: string) => Promise<string | null>): void
{
	const queryClient = useQueryClient();
	useEffect(() =>
	{
		const resolve = async (locationId: string | null): Promise<string | null> =>
			locationId === null
				? null
				: queryClient.query(
						{
							queryKey: nodeKeys.resolvedId(locationId),
							queryFn: async () => resolveId(locationId),
							staleTime: RESOLVED_ID_STALE_TIME,
						},
					);

		const handleClick = (event: MouseEvent) =>
		{
			const target = event.target instanceof Element ? event.target : null;
			if (target === null)
			{
				return;
			}
			const mode = paneClickModifier(event, isMacPlatform());

			const bullet = target.closest<HTMLElement>(BULLET_SELECTOR);
			if (bullet !== null && mode === "open" && bullet.dataset.preDragClick === "true")
			{
				claim(event);
				openInPane(useOutlineStore.getState(), bullet.dataset.itemId ?? "", paneIdOf(bullet));
				return;
			}

			const crumb = target.closest<HTMLElement>("a.breadcrumb-item[data-item-id]");
			if (crumb !== null)
			{
				if (mode === "open")
				{
					claim(event);
					const itemId = crumb.dataset.itemId;
					openInPane(
						useOutlineStore.getState(),
						itemId === "None" || itemId === undefined ? null : itemId,
						paneIdOf(crumb),
					);
				}
				return;
			}

			const row = target.closest<HTMLElement>("a.left-bar-section-item");
			if (row === null || target.closest("[data-left-bar-controls]") !== null || mode === "other")
			{
				return;
			}
			const locationUrl = row.dataset.locationUrl;
			if (locationUrl === undefined || locationUrl === "")
			{
				return;
			}
			const {id: locationId, query} = parseLocationHash(new URL(locationUrl, globalThis.location.origin).hash);
			if (mode === "plain")
			{
				const {panes} = useOutlineStore.getState();
				const paneId = focusedPaneId();
				if (panes.length === 0 || findPane(panes, paneId) === undefined)
				{
					return;
				}
				claim(event);
				blurEditor();
				void (async () =>
				{
					const resolved = await resolve(locationId);
					if (locationId !== null && resolved === null)
					{
						return;
					}
					const state = useOutlineStore.getState();
					state.zoomPane(paneId, resolved);
					state.setPaneQuery(paneId, query ?? "");
					state.setActivePane(paneId);
					document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`)?.scrollIntoView(
						{
							block: "nearest",
							inline: "nearest",
						},
					);
				})();
				return;
			}
			claim(event);
			void (async () =>
			{
				const resolved = await resolve(locationId);
				if (locationId !== null && resolved === null)
				{
					return;
				}
				const state = useOutlineStore.getState();
				state.openPane(
					resolved,
					{
						index: state.panes.length + 1,
						sourcePaneId: state.activePaneId,
						query: query ?? "",
					},
				);
			})();
		};
		document.addEventListener("click", handleClick, true);
		return () =>
		{
			document.removeEventListener("click", handleClick, true);
		};
	}, [queryClient, resolveId]);
}
