import {useEffect} from "react";
import type {ReactNode} from "react";
import {createPortal} from "react-dom";
import type {NodeAttachment} from "../../node-types.js";
import {useNode} from "../hooks/use-nodes.js";
import {useNodeNavigation} from "../navigation.js";
import {useOutlineStore} from "../stores/outline.js";
import {downloadFile, viewOriginal} from "./file-actions.js";
import {FaIcon} from "./fa-icons.js";
import {FileMenu, fileMenuRows} from "./file-menu.js";
import {originalUrl} from "./file-preview-kind.js";
import {pixelDensity} from "./file-preview-layout.js";
import {adjacentAttachment, visibleViewerRows} from "./image-viewer-model.js";
import {hideImageViewer, showImageViewer, useShownImageId} from "./image-viewer-state.js";

export interface ImageViewerViewProps
{
	nodeId: string;
	attachment: NodeAttachment | null;
	prevId: string | null;
	nextId: string | null;
	onHide: () => void;
	onShow: (nodeId: string) => void;
	/** Enter: hide and zoom into the image's item. */
	onZoom: (nodeId: string) => void;
	openSettings: () => void;
}

const GALLERY_STYLE =
{
	color: "var(--wf-text-quaternary)",
	backgroundColor: "var(--wf-background-quaternary)",
};

function GalleryButton({
	direction,
	targetId,
	onShow,
}: {
	direction: "prev" | "next";
	targetId: string | null;
	onShow: (nodeId: string) => void;
}): ReactNode
{
	return (
		// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- upstream's IconButton is a focusable div[role=button]
		<div
			// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- verbatim upstream IconButton markup
			role="button"
			tabIndex={0}
			title={direction === "prev" ? "Previous image" : "Next image"}
			className={`gallery-btn ${direction}${targetId === null ? " inactive" : ""} iconButton lg shape-circle`}
			style={GALLERY_STYLE}
			onClick={(event) =>
			{
				event.stopPropagation();
				if (targetId !== null)
				{
					onShow(targetId);
				}
			}}
			onKeyDown={(event) =>
			{
				if ((event.key === "Enter" || event.key === " ") && targetId !== null)
				{
					event.preventDefault();
					event.stopPropagation();
					onShow(targetId);
				}
			}}
		>
			<FaIcon icon={direction === "prev" ? "fal:chevron-left" : "fal:chevron-right"} />
		</div>
	);
}

/**
 * Upstream's `files.image-detail` root (`WF.Files.image.full.show`): a black 80% overlay portalled into body with the
 * file menu, prev/next gallery buttons and the original-size image. Escape hides, the arrows step through attachments,
 * Enter hides and zooms in, and a click outside `.keep-overlay` hides. It owns one `{image:true}` history entry.
 */
export function ImageViewerView(props: ImageViewerViewProps): ReactNode
{
	const {nodeId, attachment, prevId, nextId, onHide, onShow, onZoom} = props;

	useEffect(() =>
	{
		const onKeyDown = (event: KeyboardEvent) =>
		{
			const handlers: Record<string, () => void> =
			{
				Escape: onHide,
				ArrowLeft: () =>
				{
					if (prevId !== null)
					{
						onShow(prevId);
					}
				},
				ArrowRight: () =>
				{
					if (nextId !== null)
					{
						onShow(nextId);
					}
				},
				Enter: () =>
				{
					onHide();
					onZoom(nodeId);
				},
			};
			const handler = handlers[event.key];
			if (handler !== undefined)
			{
				event.preventDefault();
				event.stopPropagation();
				handler();
			}
		};
		document.body.addEventListener("keydown", onKeyDown, true);
		return () =>
		{
			document.body.removeEventListener("keydown", onKeyDown, true);
		};
	}, [nodeId, prevId, nextId, onHide, onShow, onZoom]);

	useEffect(() =>
	{
		history.pushState(
			{
				image: true,
			},
			"",
		);
		const onPopState = () =>
		{
			onHide();
		};
		window.addEventListener("popstate", onPopState);
		return () =>
		{
			window.removeEventListener("popstate", onPopState);
			if (isImageState(history.state))
			{
				history.back();
			}
		};
	}, [onHide]);

	const width =
		attachment?.imageOriginalWidth === null || attachment?.imageOriginalWidth === undefined
			? null
			: attachment.imageOriginalWidth / pixelDensity(attachment.imageOriginalPixels);
	const rows = fileMenuRows(
		{
			viewOriginal: () =>
			{
				viewOriginal(nodeId);
			},
			download: () =>
			{
				downloadFile(nodeId, attachment?.fileName ?? "");
			},
			openSettings: props.openSettings,
		},
	);

	return createPortal(
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- Escape and arrows are handled on body; the overlay click is a mouse shortcut for closing
		<div
			className="fixed overlay bg-black/80"
			style={
			{
				zIndex: 400,
				top: "var(--safe-area-inset-top)",
				left: "var(--safe-area-inset-left)",
				right: "var(--safe-area-inset-right)",
				bottom: "var(--safe-area-inset-bottom)",
				display: "flex",
				flexDirection: "column",
			}}
			onClick={(event) =>
			{
				if (!(event.target instanceof Element) || event.target.closest(".keep-overlay") === null)
				{
					onHide();
				}
			}}
		>
			<div className="h-4xl pr-l flex items-center justify-end">
				<div
					style={
					{
						display: "flex",
						alignItems: "center",
					}}
				>
					<FileMenu nodeId={nodeId} rows={rows} />
				</div>
			</div>
			<GalleryButton direction="prev" targetId={prevId} onShow={onShow} />
			<GalleryButton direction="next" targetId={nextId} onShow={onShow} />
			<div className="flex-1 flex items-center justify-center overflow-hidden">
				<div
					className="max-w-full h-full max-h-full flex items-center justify-center"
					style={
					{
						position: "relative",
						width: width === null ? undefined : `calc(min(100%, ${width}px))`,
					}}
				>
					{attachment?.fileType.startsWith("image/") === true ? (
						<img
							src={originalUrl(nodeId)}
							alt={attachment.fileName}
							className="max-w-full max-h-full pinch-element touch-none"
						/>
					) : null}
				</div>
			</div>
		</div>,
		document.body,
	);
}

function isImageState(state: unknown): boolean
{
	return typeof state === "object" && state !== null && "image" in state && state.image === true;
}

/** Mounts the full-screen viewer while `showImageViewer` has named a node, with prev/next read from the rendered rows. */
export function ImageViewerHost(): ReactNode
{
	const shownId = useShownImageId();
	const {data: node} = useNode(shownId);
	const {navigateToNode} = useNodeNavigation();
	const openSettings = useOutlineStore((state) => state.openSettings);
	if (shownId === null)
	{
		return null;
	}
	const rows = visibleViewerRows(document);
	return (
		<ImageViewerView
			nodeId={shownId}
			attachment={node?.attachment ?? null}
			prevId={adjacentAttachment(rows, shownId, "prev")}
			nextId={adjacentAttachment(rows, shownId, "next")}
			onHide={hideImageViewer}
			onShow={showImageViewer}
			onZoom={(id) =>
			{
				navigateToNode(id);
			}}
			openSettings={() =>
			{
				hideImageViewer();
				openSettings("Media & Previews");
			}}
		/>
	);
}
