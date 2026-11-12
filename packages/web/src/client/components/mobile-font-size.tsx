import {getFontSize, setFontSize, stepFontSize} from "../mobile-font-size.js";

const BUTTON_CLASS = "h-3xl w-full flex items-center justify-center cursor-pointer";

/** Upstream's `font-size` sheet: a title and two `Aa` buttons that step the row font size by 1 within 12..28. */
export function FontSizeSheet()
{
	return (
		<div className="font-size-sheet">
			<div className="py-l px-xl text-xl text-center">Text size</div>
			<div className="flex border-y border-solid border-primary">
				<button
					type="button"
					className={`${BUTTON_CLASS} text-s border-r border-solid border-primary`}
					onClick={() =>
					{
						setFontSize(stepFontSize(getFontSize(), -1));
					}}
				>
					Aa
				</button>
				<button
					type="button"
					className={`${BUTTON_CLASS} text-l`}
					onClick={() =>
					{
						setFontSize(stepFontSize(getFontSize(), 1));
					}}
				>
					Aa
				</button>
			</div>
		</div>
	);
}
