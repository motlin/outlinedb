import {useRef} from "react";
import {originalUrl} from "./file-preview-kind.js";

/** Upstream's `--video-width-real`: the video's natural aspect at a height capped to 90% of the window, in px. */
export function videoWidthCap({
	videoWidth,
	videoHeight,
	innerHeight,
}: {
	videoWidth: number;
	videoHeight: number;
	innerHeight: number;
}): number
{
	return (videoWidth / videoHeight) * Math.min(videoHeight, innerHeight * 0.9);
}

const WRAPPER_STYLE =
{
	width: "calc(min(100%, var(--video-width-real), var(--video-width, 100%)))",
	height: "auto",
} as const;

/**
 * Upstream's `gui-video.preview` (`zS2`): a react-player FilePlayer's markup, a native-controls `<video preload="auto">`
 * that is never wider than its natural width nor taller than 90% of the window.
 */
export function VideoPreview({nodeId}: {nodeId: string})
{
	const outerRef = useRef<HTMLDivElement>(null);
	return (
		<div ref={outerRef} className="[display:inherit] mobile:flex mobile:mr-[30px]">
			<div style={WRAPPER_STYLE}>
				{/* oxlint-disable-next-line jsx-a11y/media-has-caption -- attachments carry no caption track */}
				<video
					src={originalUrl(nodeId)}
					preload="auto"
					controls
					style={
					{
						width: "100%",
						height: "auto",
					}}
					onLoadedMetadata={(event) =>
					{
						const {videoWidth, videoHeight} = event.currentTarget;
						if (videoWidth > 0 && videoHeight > 0)
						{
							outerRef.current?.style.setProperty(
								"--video-width-real",
								`${videoWidthCap(
									{
										videoWidth,
										videoHeight,
										innerHeight: window.innerHeight,
									},
								)}px`,
							);
						}
					}}
				/>
			</div>
		</div>
	);
}
