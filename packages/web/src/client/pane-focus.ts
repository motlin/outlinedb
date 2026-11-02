/** Upstream's `focus.request(paneId)`: where a pane focus request wants the caret, and whether to scroll the pane into view. */
export interface PaneFocusRequest
{
	paneId: string;
	/** The zoom the pane is about to show: the request waits for its title to render. Null skips the check (Home). */
	zoomedId: string | null;
	/** Scroll the pane into view horizontally; upstream skips it after a close (`panes.closed`). */
	reveal: boolean;
}

/** Upstream's `rj4` fallback target: the pane's first `.name .content`, the zoom title when zoomed, else the first row. */
export function paneFocusTarget(paneRoot: ParentNode): HTMLElement | null
{
	return paneRoot.querySelector<HTMLElement>(".name .content");
}

const MAX_FRAMES = 60;

let pendingRequest = 0;

/**
 * Upstream's `dt.request` plus `rj4`/`Ky4`: on the next animation frame put the caret at offset 0 of the pane's first
 * `.name .content` and scroll the pane into view, retrying for up to 60 frames while the pane or its title has not
 * rendered. A newer request cancels a pending one.
 */
export function requestPaneFocus(
	request: PaneFocusRequest,
	deps:
	{
		resumeEditing: (nodeId: string, offset: number) => void;
	},
): void
{
	const token = ++pendingRequest;
	let frames = 0;
	const attempt = (): void =>
	{
		if (token !== pendingRequest)
		{
			return;
		}
		frames++;
		const paneElement = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(request.paneId)}"]`);
		const target = paneElement === null ? null : paneFocusTarget(paneElement);
		const nodeId = target?.querySelector<HTMLElement>("[data-node-id]")?.dataset.nodeId;
		const rendered = nodeId !== undefined && (request.zoomedId === null || nodeId === request.zoomedId);
		if (paneElement === null || !rendered)
		{
			if (frames < MAX_FRAMES)
			{
				requestAnimationFrame(attempt);
			}
			else if (paneElement !== null && nodeId !== undefined)
			{
				place(paneElement, nodeId);
			}
			return;
		}
		place(paneElement, nodeId);
	};
	const place = (paneElement: HTMLElement, nodeId: string): void =>
	{
		deps.resumeEditing(nodeId, 0);
		if (request.reveal)
		{
			paneElement.scrollIntoView(
				{
					block: "nearest",
					inline: "nearest",
				},
			);
		}
	};
	requestAnimationFrame(attempt);
}
