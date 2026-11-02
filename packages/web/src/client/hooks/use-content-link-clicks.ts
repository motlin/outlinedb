import {useQueryClient} from "@tanstack/react-query";
import {useEffect} from "react";
import {afterNextPaint} from "../after-paint.js";
import {planContentLinkClick} from "../content-link-click.js";
import {isMacPlatform} from "../editable-text-keys.js";
import {goToNode, navigateToSearch} from "../navigation.js";
import {RESOLVED_ID_STALE_TIME, nodeKeys} from "../node-cache.js";
import {openInPane} from "../pane-commands.js";
import {MAIN_PANE_ID} from "../pane-ids.js";
import {activeZoomedId, useOutlineStore} from "../stores/outline.js";
import {useStableNavigate} from "./use-stable-navigate.js";

/** A stored link in rest mode (`a.contentLink`) or in the row being edited, where the editor may emit a bare `<a href>`. */
const CONTENT_LINK_SELECTOR = "a.contentLink, .content a[href]";

function contentLinkOf(event: Event): HTMLAnchorElement | null
{
	return event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(CONTENT_LINK_SELECTOR) : null;
}

export function claim(event: Event): void
{
	event.preventDefault();
	event.stopPropagation();
	event.stopImmediatePropagation();
}

/** Commit and leave the edited row, as upstream blurs the focused editor before a link navigates or opens. */
export function blurEditor(): void
{
	const {editingId, stopEditing} = useOutlineStore.getState();
	if (editingId !== null)
	{
		if (document.activeElement instanceof HTMLElement)
		{
			document.activeElement.blur();
		}
		stopEditing();
	}
}

/**
 * Upstream's document-level link handlers for `a.contentLink`. A left `mousedown` on a link is cancelled so the row
 * never enters edit mode. A click then routes by `planContentLinkClick`: ⌘-click (⌃ off mac) or ⌥-click opens the item
 * in a pane, a plain or ⇧ click navigates in-app (a side pane's own link navigates that pane), `search:` links run a
 * search, and everything else opens in a new tab through `window.open`, as does a middle click. Capture runs before
 * React's row handlers, so a claimed click neither follows the href nor starts editing. Mount once (the app owns it).
 */
export function useContentLinkClicks(resolveId: (locationId: string) => Promise<string | null>): void
{
	const queryClient = useQueryClient();
	const navigate = useStableNavigate();
	useEffect(() =>
	{
		const handleMouseDown = (event: MouseEvent) =>
		{
			if (event.button === 0 && contentLinkOf(event) !== null)
			{
				event.preventDefault();
				event.stopPropagation();
			}
		};
		const handleAuxClick = (event: MouseEvent) =>
		{
			const href = contentLinkOf(event)?.getAttribute("href");
			if (event.button !== 1 || href === null || href === undefined)
			{
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			globalThis.open(href);
		};
		const handleClick = (event: MouseEvent) =>
		{
			const link = contentLinkOf(event);
			const href = link?.getAttribute("href");
			if (link === null || href === null || href === undefined)
			{
				return;
			}
			const sourcePaneId = link.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? MAIN_PANE_ID;
			const plan = planContentLinkClick(
				href,
				event,
				{
					isMac: isMacPlatform(),
					inSidePane: sourcePaneId !== MAIN_PANE_ID,
					origin: globalThis.location.origin,
				},
			);
			if (plan === null)
			{
				return;
			}
			claim(event);
			if (plan.kind === "open")
			{
				blurEditor();
				globalThis.open(plan.href);
				return;
			}
			if (plan.kind === "search")
			{
				blurEditor();
				navigateToSearch(navigate, plan.query);
				return;
			}
			const {loc} = plan;
			const locationId = loc.id;
			void (async () =>
			{
				const resolved =
					locationId === null
						? null
						: await queryClient.query(
								{
									queryKey: nodeKeys.resolvedId(locationId),
									queryFn: async () => resolveId(locationId),
									staleTime: RESOLVED_ID_STALE_TIME,
								},
							);
				if (plan.kind === "navigate")
				{
					// An unknown id lands Home, like upstream, with no warning.
					blurEditor();
					goToNode(navigate, resolved, loc.query);
					await afterNextPaint();
					const state = useOutlineStore.getState();
					if (resolved !== null && activeZoomedId(state) === resolved)
					{
						state.resumeEditing(resolved, 0);
					}
					return;
				}
				if (resolved === null)
				{
					return;
				}
				const state = useOutlineStore.getState();
				if (plan.kind === "open_in_pane")
				{
					openInPane(state, resolved, sourcePaneId);
				}
				else
				{
					state.zoomPane(sourcePaneId, resolved);
				}
			})();
		};
		document.addEventListener("mousedown", handleMouseDown, true);
		document.addEventListener("auxclick", handleAuxClick, true);
		document.addEventListener("click", handleClick, true);
		return () =>
		{
			document.removeEventListener("mousedown", handleMouseDown, true);
			document.removeEventListener("auxclick", handleAuxClick, true);
			document.removeEventListener("click", handleClick, true);
		};
	}, [queryClient, resolveId, navigate]);
}
