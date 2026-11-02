// Upstream standalone Flyout level: WF.Design.level.of("popup").
export const POPUP_Z = 300;
// Upstream ButtonMenu level.
export const BUTTON_MENU_Z = 1001;

export interface PopoverBoxOptions
{
	surfaceName?: string;
	minWidth?: number | string;
	maxWidth?: number | string;
	// Upstream reads only offset[1]; the horizontal component is ignored.
	offset?: readonly [number, number];
}

export interface PopoverBoxStyle
{
	pointerEvents: "auto";
	zIndex: number;
	minWidth: number | string | undefined;
	maxWidth: number | string | undefined;
	marginTop?: number;
}

export interface PopoverBox
{
	style: PopoverBoxStyle;
	className: string;
}

export function popoverBox({surfaceName = "wf-menu", minWidth, maxWidth, offset}: PopoverBoxOptions = {}): PopoverBox
{
	const style: PopoverBoxStyle =
	{
		pointerEvents: "auto",
		zIndex: POPUP_Z,
		minWidth,
		maxWidth,
	};
	if (offset)
	{
		style.marginTop = offset[1] + 4;
	}
	// Matches the upstream bundle template literal byte for byte, including newlines and indentation.
	const className = `${surfaceName} flex flex-col
      border border-solid border-primary font-normal text-xs
      rounded-md bg-primary shadow-md
      overflow-x-hidden
      [transition:200ms_opacity]
      print:hidden`;
	return {
		style,
		className,
	};
}
