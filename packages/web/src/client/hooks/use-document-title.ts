import {useEffect, useRef} from "react";
import {renderDatePills} from "../date-pills.js";
import {NONAME_TITLE, nextTitle} from "../document-title.js";
import type {TitleState} from "../document-title.js";
import {useOutlineStore} from "../stores/outline.js";
import {useNode} from "./use-nodes.js";
import {useDateSettings} from "./use-preferences.js";

/**
 * Upstream's `BE1`: the tab title follows the zoomed node, set on navigation only. A rename of the zoomed node keeps the
 * old title until the next navigation, and a search query never changes it.
 */
function useDocumentTitle(): void
{
	const zoomedNodeId = useOutlineStore((state) => state.zoomedNodeId);
	const node = useNode(zoomedNodeId).data;
	const dates = useDateSettings();
	const state = useRef<TitleState>(
		{
			zoomId: undefined,
			title: null,
		},
	);
	const loaded = zoomedNodeId === null || node !== undefined;
	// A rename or a late preferences load must not retitle, so the effect reads these through a ref.
	const latest = useRef(
		{
			name: node?.name,
			dates,
		},
	);
	useEffect(() =>
	{
		latest.current =
		{
			name: node?.name,
			dates,
		};
	});
	useEffect(() =>
	{
		if (!loaded)
		{
			return;
		}
		const title = nextTitle(
			state.current,
			{
				zoomId: zoomedNodeId,
				nameHtml: zoomedNodeId === null ? null : latest.current.name,
			},
			(html) => renderDatePills(html, latest.current.dates),
		);
		if (title !== null)
		{
			state.current =
			{
				zoomId: zoomedNodeId,
				title,
			};
			document.title = title;
		}
	}, [zoomedNodeId, loaded]);
}

/** The local-only routes `/changes` and `/ladder` have no upstream twin: they get the noname title. */
export function NonameTitle(): null
{
	useEffect(() =>
	{
		document.title = NONAME_TITLE;
	}, []);
	return null;
}

/** Renders nothing: it holds the title hook's subscriptions so a zoom re-renders only this, not the page. */
export function DocumentTitle(): null
{
	useDocumentTitle();
	return null;
}
