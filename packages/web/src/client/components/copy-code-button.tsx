import {useEffect, useRef, useState} from "react";
import {FaIcon} from "./fa-icons.js";

/** How long "Copied!" shows, as upstream's copy-code button. */
const COPIED_MS = 2000;

/**
 * Upstream's "Copy code" button in a code block's top-right corner: it copies the block's plain text and shows
 * "Copied!" for two seconds. It never starts editing or an item selection.
 */
export function CopyCodeButton({plainText}: {plainText: string})
{
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(
		() => () =>
		{
			clearTimeout(timer.current);
		},
		[],
	);
	return (
		<div className="absolute top-0 right-0 flex flex-row items-center text-xs">
			{copied && (
				<span
					className="p-1 rounded-sm"
					style={
					{
						background: "var(--wf-background-tertiary)",
					}}
				>
					Copied!
				</span>
			)}
			<button
				className="shape-square iconButton md p-1 m-1 bg-transparent"
				title="Copy code"
				type="button"
				onMouseDown={(event) =>
				{
					event.preventDefault();
					event.stopPropagation();
				}}
				onClick={(event) =>
				{
					event.stopPropagation();
					void navigator.clipboard.writeText(plainText);
					setCopied(true);
					clearTimeout(timer.current);
					timer.current = setTimeout(() =>
					{
						setCopied(false);
					}, COPIED_MS);
				}}
			>
				<FaIcon icon={copied ? "fal:check" : "fal:copy"} />
			</button>
		</div>
	);
}
