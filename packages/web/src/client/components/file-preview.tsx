import type {CSSProperties, MouseEvent, ReactNode} from "react";
import type {NodeAttachment} from "../../node-types.js";
import {AudioPreview} from "./audio-preview.js";
import {downloadFile, viewOriginal} from "./file-actions.js";
import {FileMenu, fileMenuRows} from "./file-menu.js";
import {aspect, previewWidth} from "./file-preview-layout.js";
import {originalUrl, previewKind} from "./file-preview-kind.js";
import {VideoPreview} from "./video-preview.js";

const FILE_PREVIEW_CLASS =
	"w-full relative file-preview ml-[var(--space-for-bullet)] max-w-[calc(100%-var(--space-for-bullet))]";
const VIEWER_CLASS =
	"box-border border border-solid border-secondary rounded-[3px] cursor-pointer overflow-hidden image-viewer";

export interface FilePreviewActions
{
	/** Mousedown on the image: first focuses the row, the next opens the full-screen viewer. */
	onImageMouseDown: (event: MouseEvent<HTMLImageElement>) => void;
	showFullScreen: () => void;
	openSettings: () => void;
}

export interface FilePreviewViewProps extends FilePreviewActions
{
	nodeId: string;
	attachment: NodeAttachment | null;
	/** The row's name; an empty name gives the image box the blinking caret border. */
	name: string;
	zoomedIn: boolean;
	innerWidth: number;
	thumbs: boolean;
	devicePixelRatio: number;
}

/** The preview image's URL: the proxy resizes to the next 400px step at or above the displayed pixel width. */
export function previewImageSrc(nodeId: string, cssWidth: number, devicePixelRatio: number): string
{
	return `/api/v1/files/${nodeId}/preview?w=${Math.ceil(cssWidth * devicePixelRatio)}`;
}

function ImagePreview(
	props: FilePreviewViewProps &
	{
		attachment: NodeAttachment;
	},
): ReactNode
{
	const {nodeId, attachment, name, zoomedIn, innerWidth, thumbs, devicePixelRatio} = props;
	const width = previewWidth(
		{
			zoomedIn,
			innerWidth,
			thumbs,
			w: attachment.imageOriginalWidth,
			pixels: attachment.imageOriginalPixels,
		},
	);
	const ratio = aspect(attachment.imageOriginalWidth, attachment.imageOriginalHeight);
	const style =
	{
		width: `calc(min(100%, ${width}px))`,
		"--image-viewer-h": ratio === null ? undefined : "0",
		"--image-viewer-pb": ratio === null ? undefined : `calc(100% * ${ratio})`,
	} as CSSProperties;
	const rows = fileMenuRows(
		{
			showFullScreen: props.showFullScreen,
			viewOriginal: () =>
			{
				viewOriginal(nodeId);
			},
			download: () =>
			{
				downloadFile(nodeId, attachment.fileName);
			},
			openSettings: props.openSettings,
		},
	);
	return (
		<div className="mt-[7px] max-w-full" style={style}>
			<div
				className={`${VIEWER_CLASS}${name === "" ? " image-viewer--no-name" : ""}`}
				style={
				{
					position: "relative",
				}}
			>
				{/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- upstream's image focuses the row on press; keyboard users reach it through the row */}
				<img
					draggable={false}
					style={
					{
						width: "100%",
					}}
					alt={attachment.fileName}
					src={previewImageSrc(nodeId, width, devicePixelRatio)}
					onMouseDown={props.onImageMouseDown}
				/>
				<style>{`body.button-menu-for-${nodeId} .imagePreviewMenu { display: block }`}</style>
				<div className="absolute top-m right-m hidden imagePreviewMenu">
					<FileMenu nodeId={nodeId} rows={rows} />
				</div>
			</div>
		</div>
	);
}

/**
 * Upstream's `.file-preview` slot after `.name`: the first `GuiFilePreviews` entry that fits (image, audio, pdf, video)
 * or, for any other file, a Download button. Nothing renders for a missing or deleted attachment.
 */
export function FilePreviewView(props: FilePreviewViewProps): ReactNode
{
	const {attachment, nodeId} = props;
	const kind = previewKind(attachment);
	if (attachment === null || kind === "none")
	{
		return null;
	}
	let content: ReactNode;
	if (kind === "image")
	{
		content = <ImagePreview {...props} attachment={attachment} />;
	}
	else if (kind === "audio")
	{
		content = <AudioPreview nodeId={nodeId} fileName={attachment.fileName} />;
	}
	else if (kind === "video")
	{
		content = <VideoPreview nodeId={nodeId} />;
	}
	else
	{
		content = (
			<a
				className="button secondary"
				style={
				{
					paddingTop: 2,
					paddingBottom: 2,
				}}
				href={originalUrl(nodeId)}
				download={attachment.fileName}
			>
				Download
			</a>
		);
	}
	return <div className={FILE_PREVIEW_CLASS}>{content}</div>;
}
