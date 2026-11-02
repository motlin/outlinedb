import {createPortal} from "react-dom";
import {TAG_COLORS} from "../../tag-colors.js";
import {useCloseOnLocationChange} from "../hooks/use-close-on-location-change.js";
import type {TagColorName} from "../../tag-colors.js";
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

/**
 * Upstream's tag color flyout ("colors.tags-mouse"): a "remove color" swatch
 * (diagonal red stroke) then one far-font swatch per color, cloned from
 * `dumps/tags-autocomplete-upstream-color-picker.html`.
 *
 * Tag colors apply globally to every instance of the tag. Rendered via a
 * portal to document.body with fixed positioning, so the viewport rect of the
 * tag places it, not the transformed (virtualized) outline rows. The extra
 * `tag-color-picker` class only marks the flyout for outside-click detection.
 */

export type {TagColorName};
export {swatchClick};

interface TagColorPickerProps
{
	/** Viewport coordinates of the tag's bottom-left corner; upstream adds a 4px margin-top. */
	top: number;
	left: number;
	currentColor?: string;
	onSelect: (color: TagColorName) => void;
	onRemove: () => void;
	/** Upstream closes the flyout when the location changes. */
	onClose: () => void;
}

// (10 colors + remove) * 32px pitch + 32px insets.
const MAX_WIDTH = (TAG_COLORS.length + 1) * 32 + 32;

export function TagColorPicker({top, left, currentColor, onSelect, onRemove, onClose}: TagColorPickerProps)
{
	useCloseOnLocationChange(onClose);
	const box = popoverBox(
		{
			maxWidth: MAX_WIDTH,
		},
	);
	const surface = box.className.replaceAll(/\s+/gu, " ");
	return createPortal(
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- upstream's flyout is a plain div; mousedown only keeps editor focus
		<div
			className={`${surface} flyout !pt-0 !pb-0 overflow-hidden tag-color-picker`}
			// Keep the editor's selection/focus when interacting with the picker.
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
			}}
		>
			<div>
				<div className="w-full box-border p-s">
					<div className="flex flex-col gap-ml px-m pt-m">
						<div className="mobile:mb-l">
							<div className="w-full mobile:overflow-x-auto scrollbar-hide [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
								<div className="flex gap-m mobile:gap-ml mobile:pl-l mobile:min-w-max">
									{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's swatches are pointer-only divs */}
									<div title="remove color" className={CANCEL_SWATCH} onClick={onRemove}>
										<CancelIcon />
									</div>
									{TAG_COLORS.map((color, index) => (
										// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's swatches are pointer-only divs
										<div
											title={capitalize(color)}
											className={`${SWATCH} ${currentColor === color ? SELECTED_BORDER : UNSELECTED_BORDER}${index === TAG_COLORS.length - 1 ? " mobile:mr-l" : ""} bc-${color}`}
											key={color}
											onClick={() =>
											{
												const picked = swatchClick(currentColor, color);
												if (picked === null)
												{
													onRemove();
												}
												else
												{
													onSelect(picked);
												}
											}}
										>
											<FaIcon icon="far:font" />
										</div>
									))}
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
