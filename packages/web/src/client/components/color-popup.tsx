import {useEffect, useRef} from "react";
import {createPortal} from "react-dom";
import {COLOR_ORDER} from "../../color-palette.js";
import type {ColorName} from "../../color-palette.js";
import {useCloseOnLocationChange} from "../hooks/use-close-on-location-change.js";
import type {ColorKind} from "../rich-text.js";
import
{
	CANCEL_SWATCH,
	CancelIcon,
	SELECTED_BORDER,
	SWATCH,
	UNSELECTED_BORDER,
	capitalize,
	swatchClick,
} from "./color-swatches.js";
import {FaIcon} from "./fa-icons.js";
import {POPUP_Z, popoverBox} from "./flyout/popover-box.js";

/** `(10 + 1) * 32 + 32`: upstream's flyout max width. */
const MAX_WIDTH = (COLOR_ORDER.length + 1) * 32 + 32;

export interface ColorPopupProps
{
	/** Viewport left and bottom of the selection (or of the last selected item's content). */
	left: number;
	top: number;
	/** The colors covering the whole selection, by kind; the matching swatches show the selected border. */
	selected:
	{
		text?: ColorName | undefined;
		highlight?: ColorName | undefined;
	};
	/** A swatch was picked, or `null` for "remove color" or a click on the selected swatch. */
	onSelect: (kind: ColorKind, color: ColorName | null) => void;
	/** The popup should close (outside click, location change). */
	onClose: () => void;
	/** Escape: the controller also collapses the caret to the selection start. */
	onEscape?: () => void;
}

/** Whether `left` would push the 384px flyout past the viewport, in which case upstream centers it. */
// oxlint-disable-next-line react/only-export-components -- pure placement rule, tested beside the component
export function popupCentered(left: number, viewportWidth: number): boolean
{
	return left + MAX_WIDTH > viewportWidth;
}

const ROWS: readonly
{
	kind: ColorKind;
	label: string;
	rowClass: string;
	colorClass: string;
}[] = [
	{
		kind: "text",
		label: "Text",
		rowClass: "picker-text",
		colorClass: "c",
	},
	{
		kind: "highlight",
		label: "Highlight",
		rowClass: "picker-background",
		colorClass: "bc",
	},
];

/**
 * Upstream's text/highlight color flyout (`colors.text-mouse`): a "Text" row and a "Highlight" row, each a
 * "remove color" swatch plus ten "A" swatches in display order, over a `Style text/apply style` footer.
 * Cloned from `dumps/color-highlight-popup-upstream-dom-2026-10-23.html`.
 */
export function ColorPopup({left, top, selected, onSelect, onClose, onEscape}: ColorPopupProps)
{
	useCloseOnLocationChange(onClose);
	const ref = useRef<HTMLDivElement>(null);
	const handlers = useRef(
		{
			onClose,
			onEscape,
		},
	);
	useEffect(() =>
	{
		handlers.current =
		{
			onClose,
			onEscape,
		};
	});
	useEffect(() =>
	{
		const onKeyDown = (event: KeyboardEvent) =>
		{
			if (event.key === "Escape")
			{
				event.preventDefault();
				event.stopPropagation();
				(handlers.current.onEscape ?? handlers.current.onClose)();
			}
		};
		const onPointerDown = (event: MouseEvent) =>
		{
			if (!(event.target instanceof Node && ref.current?.contains(event.target)))
			{
				handlers.current.onClose();
			}
		};
		// Upstream attaches the outside-click listener on the next tick, so the opening click does not close it.
		const timer = setTimeout(() =>
		{
			document.addEventListener("mousedown", onPointerDown, true);
		}, 0);
		document.addEventListener("keydown", onKeyDown, true);
		return () =>
		{
			clearTimeout(timer);
			document.removeEventListener("mousedown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, []);

	const box = popoverBox(
		{
			maxWidth: MAX_WIDTH,
		},
	);
	const centered = typeof window !== "undefined" && popupCentered(left, window.innerWidth);
	return createPortal(
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- upstream's flyout is a plain div; mousedown only keeps the selection
		<div
			ref={ref}
			className={`${box.className} absolute flyout !pt-0 !pb-0 overflow-hidden `}
			// The swatches are plain divs: keep the editor's focus and selection.
			onMouseDown={(event) =>
			{
				event.preventDefault();
			}}
			style={
			{
				pointerEvents: "auto",
				zIndex: POPUP_Z,
				maxWidth: MAX_WIDTH,
				marginTop: 4,
				position: "fixed",
				left,
				top,
				transform: `scale(1, 1) translateX(${centered ? "-50%" : "0px"})`,
				transformOrigin: "10% 0px",
				opacity: 1,
			}}
		>
			<div>
				<div className="w-full p-m gap-ml flex flex-col">
					{ROWS.map(({kind, label, rowClass, colorClass}) => (
						<div className={`mobile:mb-l ${rowClass}`} key={kind}>
							<div className="mb-m mobile:ml-l mobile:text-base">{label}</div>
							<div className="w-full mobile:overflow-x-auto scrollbar-hide [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
								<div className="flex gap-m mobile:gap-ml mobile:pl-l mobile:min-w-max">
									{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's swatches are pointer-only divs */}
									<div
										title="remove color"
										className={CANCEL_SWATCH}
										onClick={() =>
										{
											onSelect(kind, null);
										}}
									>
										<CancelIcon />
									</div>
									{COLOR_ORDER.map((color, index) => (
										// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's swatches are pointer-only divs
										<div
											title={capitalize(color)}
											className={`${SWATCH} ${selected[kind] === color ? SELECTED_BORDER : UNSELECTED_BORDER}${index === COLOR_ORDER.length - 1 ? " mobile:mr-l" : ""} ${colorClass}-${color}`}
											key={color}
											onClick={() =>
											{
												onSelect(kind, swatchClick(selected[kind], color));
											}}
										>
											<FaIcon icon="far:font" />
										</div>
									))}
								</div>
							</div>
						</div>
					))}
				</div>
				<div className="mt-m p-m flex justify-between text-xs bg-secondary text-secondary">
					<div>Style text/apply style</div>
					<div>⌘⇧H</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
