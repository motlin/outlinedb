import type {TagColorName} from "../../tag-colors.js";

/**
 * Upstream's color swatch strings, shared by the tag color flyout and the text/highlight popup
 * (`colors.tags-mouse` / `colors.text-mouse`).
 */
export const SWATCH =
	"box-border h-[24px] w-[24px] flex items-center justify-center relative cursor-pointer bg-inherit rounded-s mobile:h-[36px] mobile:w-[36px] mobile:flex-shrink-0";
export const UNSELECTED_BORDER = "border border-solid border-primary hover:border-strong";
export const SELECTED_BORDER = "border border-solid border-strong";
export const CANCEL_SWATCH = `${SWATCH} border border-primary border-solid hover:border-strong cancel`;

/** Clicking the already-selected color removes it (upstream sends -1); any other swatch picks its color. */
export function swatchClick(current: string | undefined, clicked: TagColorName): TagColorName | null
{
	return current === clicked ? null : clicked;
}

export function capitalize(color: string): string
{
	return color.slice(0, 1).toUpperCase() + color.slice(1);
}

/** The "remove color" swatch's diagonal red stroke. */
export function CancelIcon()
{
	return (
		<svg viewBox="0 0 100 100">
			<line x1="0" y1="100" x2="100" y2="0" stroke="#EB5757" strokeWidth="8" />
		</svg>
	);
}
