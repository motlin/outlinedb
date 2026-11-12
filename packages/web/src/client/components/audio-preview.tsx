import {useRef, useState} from "react";
import {downloadFile} from "./file-actions.js";
import {FaIcon} from "./fa-icons.js";
import {formatMediaTime, originalUrl} from "./file-preview-kind.js";

/**
 * Upstream's `gui-audio` (`vA4`): a hidden `<audio preload="metadata">` plus a `div.audio--player` with a play/pause
 * button, `mm:ss / mm:ss` (or `Loading...` until the duration is known), a seek range in milliseconds and a download button.
 */
export function AudioPreview({nodeId, fileName}: {nodeId: string; fileName: string})
{
	const audioRef = useRef<HTMLAudioElement>(null);
	const [state, setState] = useState(
		{
			paused: true,
			current: 0,
			duration: Number.NaN,
		},
	);
	const sync = () =>
	{
		const audio = audioRef.current;
		if (audio !== null)
		{
			setState(
				{
					paused: audio.paused,
					current: audio.currentTime,
					duration: audio.duration,
				},
			);
		}
	};
	const durationKnown = !Number.isNaN(state.duration);
	return (
		<>
			{/* oxlint-disable-next-line jsx-a11y/media-has-caption -- the element is hidden; the custom player is the control */}
			<audio
				ref={audioRef}
				preload="metadata"
				src={originalUrl(nodeId)}
				onPlay={sync}
				onPause={sync}
				onLoadedData={sync}
				onTimeUpdate={sync}
			/>
			<div className="audio--player">
				<button
					className="button"
					type="button"
					onClick={() =>
					{
						const audio = audioRef.current;
						if (audio === null)
						{
							return;
						}
						if (audio.paused)
						{
							void audio.play();
						}
						else
						{
							audio.pause();
						}
					}}
				>
					<FaIcon icon={state.paused ? "fas:play" : "fas:pause"} size="sm" />
				</button>
				<div>
					{durationKnown
						? `${formatMediaTime(state.current)} / ${formatMediaTime(state.duration)}`
						: "Loading..."}
				</div>
				<input
					type="range"
					// Local addition: DevTools flags a form field with no id or name.
					name="audio-seek"
					max={state.duration * 1000 || 0}
					value={state.current * 1000 || 0}
					onChange={(event) =>
					{
						const audio = audioRef.current;
						if (audio !== null)
						{
							audio.currentTime = Number(event.target.value) / 1000;
							sync();
						}
					}}
				/>
				<button
					className="button"
					type="button"
					onClick={() =>
					{
						downloadFile(nodeId, fileName);
					}}
				>
					<FaIcon icon="fal:download" size="sm" />
				</button>
			</div>
		</>
	);
}
