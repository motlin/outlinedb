import {useCallback, useEffect, useRef, useState} from "react";
import type {ReactNode} from "react";
import {createPortal} from "react-dom";
import {FaIcon} from "../components/fa-icons.js";
import {TagColorPicker} from "../components/tag-color-picker.js";
import type {TagColorName} from "../components/tag-color-picker.js";
import {isMacPlatform} from "../editable-text-keys.js";
import {renderLinks} from "../link-render.js";
import {closeOnEscape} from "../menu-escape.js";
import {otherPopupOpen} from "./use-selection-toolbar.js";
import {pop, unpop} from "../popups.js";
import {isModalOpen} from "../stores/outline.js";
import {isTagDeleteClick, removeTagFromHtml, renderedTagStarts, tagCaretUnits, teaserPosition} from "../tag-render.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {mentionSearchQuery, removeMentionFromHtml} from "../mention-click.js";
import {useAccount} from "./use-account.js";
import {usePaneTagSearch} from "./use-commit-search.js";
import {usePaneSearch} from "./use-pane-search.js";
import {useRemoveTagColor, useSetTagColor, useTagColors} from "./use-tag-colors.js";

function teaserStyle(tag: {top: number; right: number; bottom: number}): React.CSSProperties
{
	const {left, top} = teaserPosition(
		{
			top: tag.top,
			right: tag.right,
			height: tag.bottom - tag.top,
		},
	);
	return {
		top: `${top}px`,
		left: `${left}px`,
	};
}

/** Upstream marks a hovered tag `contentTagDeleteHover` while the delete modifier is held. */
function markTagDeleteHover(
	tagEl: Element,
	event:
	{
		metaKey: boolean;
		altKey: boolean;
	},
): void
{
	tagEl.classList.toggle("contentTagDeleteHover", isTagDeleteClick(event, isMacPlatform()));
}

/** Pressing or releasing the modifier over a hovered tag updates its class. */
function onTagDeleteKey(event: KeyboardEvent): void
{
	for (const tagEl of document.querySelectorAll(".contentTag:hover"))
	{
		markTagDeleteHover(tagEl, event);
	}
}

let tagDeleteKeysInstalled = false;

/** Installs the one document listener for `onTagDeleteKey` on the first tag hover. */
function installTagDeleteKeys(): void
{
	if (tagDeleteKeysInstalled)
	{
		return;
	}
	tagDeleteKeysInstalled = true;
	document.addEventListener("keydown", onTagDeleteKey);
	document.addEventListener("keyup", onTagDeleteKey);
}

/** Upstream: mousedown on a tag never places a caret or moves focus. */
function preventTagMouseDown(event: React.MouseEvent<HTMLElement>): void
{
	if (event.target instanceof Element && event.target.closest(".explosive"))
	{
		event.preventDefault();
	}
}

interface RestingTagColorPickerProps
{
	tag: string;
	top: number;
	left: number;
	onClose: () => void;
}

/** The tag color picker with its color mutations, mounted only while open so a resting row holds none of them. */
function RestingTagColorPicker({tag, top, left, onClose}: RestingTagColorPickerProps)
{
	const tagColors = useTagColors();
	const setTagColorMutation = useSetTagColor();
	const removeTagColorMutation = useRemoveTagColor();
	return (
		<TagColorPicker
			currentColor={tagColors[tag.toLowerCase()]}
			left={left}
			onClose={onClose}
			onRemove={() =>
			{
				removeTagColorMutation.mutate(tag);
				onClose();
			}}
			onSelect={(color: TagColorName) =>
			{
				setTagColorMutation.mutate(
					{
						name: tag,
						color,
					},
				);
				onClose();
			}}
			top={top}
		/>
	);
}

interface TagPointerOptions
{
	/** The field's stored HTML right now: the saved name at rest, the serialized editor while editing. */
	getHtml: () => string;
	/** Stores the HTML with its tag exploded and puts the caret at `caret` (plain-text units). */
	save: (html: string, caret: number) => void;
}

export interface TagPointer
{
	/** Handles a click on a rendered tag (explode or search toggle); false when the click was not on a tag. */
	onClick: (event: React.MouseEvent<HTMLElement>) => boolean;
	onMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
	onMouseOver: (event: React.MouseEvent<HTMLElement>) => void;
	onMouseLeave: () => void;
	popups: ReactNode;
}

/**
 * Upstream's tag pointer handling for any field that renders `.contentTag` spans (a resting or editing name, a
 * note): Meta/Alt-click explodes the tag, a plain click blurs and toggles it in the search, and hovering shows the
 * color teaser that opens the picker.
 */
export function useTagPointer({getHtml, save}: TagPointerOptions): TagPointer
{
	const toggleTagSearch = usePaneTagSearch();
	const searchPane = usePaneSearch();
	const account = useAccount();
	// Tag color affordances: a caret appears on tag hover; clicking it opens the picker.
	const [tagHover, setTagHover] = useState<
	{
		tag: string;
		top: number;
		right: number;
		bottom: number;
		left: number;
	} | null>(null);
	const [colorPicker, setColorPicker] = useState<
	{
		tag: string;
		top: number;
		left: number;
	} | null>(null);
	const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	/** Upstream tag explode: drop the clicked tag and its following spaces in one undo step. */
	const explodeTag = useCallback(
		(container: HTMLElement, tagEl: Element) =>
		{
			const html = getHtml();
			const ordinal = [...container.querySelectorAll(".contentTag")].indexOf(tagEl);
			const start = renderedTagStarts(renderLinks(html))[ordinal];
			if (start === undefined)
			{
				return;
			}
			const name = removeTagFromHtml(html, start, tagEl.textContent);
			if (name === html)
			{
				return;
			}
			void runInUndoBatch(captureOutlineView, () =>
			{
				save(name, tagCaretUnits(name, start));
			});
		},
		[getHtml, save],
	);

	/** Upstream's mention pill click: Meta/Alt deletes the pill, a plain click blurs and searches `mentioned:"Name"`. */
	const onMentionClick = useCallback(
		(event: React.MouseEvent<HTMLElement>, pill: Element): void =>
		{
			event.preventDefault();
			event.stopPropagation();
			if (isTagDeleteClick(event, isMacPlatform()))
			{
				const ordinal = [...event.currentTarget.querySelectorAll("mention")].indexOf(pill);
				const removed = removeMentionFromHtml(getHtml(), ordinal);
				if (removed !== null)
				{
					void runInUndoBatch(captureOutlineView, () =>
					{
						save(removed.html, removed.caret);
					});
				}
				return;
			}
			if (document.activeElement instanceof HTMLElement)
			{
				document.activeElement.blur();
			}
			pill.classList.add("tapped");
			searchPane(mentionSearchQuery(pill.getAttribute("id") ?? "", account));
		},
		[account, getHtml, save, searchPane],
	);

	const onClick = useCallback(
		(event: React.MouseEvent<HTMLElement>): boolean =>
		{
			const target = event.target;
			const pill = target instanceof Element ? target.closest("mention") : null;
			if (pill !== null)
			{
				onMentionClick(event, pill);
				return true;
			}
			const tagEl = target instanceof Element ? target.closest(".contentTag") : null;
			if (tagEl === null)
			{
				return false;
			}
			if (isTagDeleteClick(event, isMacPlatform()))
			{
				event.preventDefault();
				event.stopPropagation();
				explodeTag(event.currentTarget, tagEl);
				return true;
			}
			const tagText = tagEl.textContent;
			if (tagText)
			{
				event.preventDefault();
				event.stopPropagation();
				if (document.activeElement instanceof HTMLElement)
				{
					document.activeElement.blur();
				}
				tagEl.classList.add("tapped");
				toggleTagSearch(tagText);
			}
			return true;
		},
		[explodeTag, onMentionClick, toggleTagSearch],
	);

	// Show the color teaser when hovering a tag; upstream's 150ms hide delay lets the
	// pointer travel from the tag to the teaser without it disappearing.
	const cancelHide = useCallback(() =>
	{
		if (hideTimer.current !== null)
		{
			clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
	}, []);

	const scheduleHide = useCallback(() =>
	{
		cancelHide();
		hideTimer.current = globalThis.setTimeout(() =>
		{
			unpop("TAG_COLOR_TEASER_POPUP");
			setTagHover(null);
		}, 150);
	}, [cancelHide]);

	// Upstream: leaving the tag (even onto plain text in the same row) requests the close,
	// and the teaser never opens over another popup (openGently).
	const onMouseOver = useCallback(
		(event: React.MouseEvent<HTMLElement>) =>
		{
			const tagEl = event.target instanceof Element ? event.target.closest(".contentTag") : null;
			if (!tagEl)
			{
				if (tagHover)
				{
					scheduleHide();
				}
				return;
			}
			if (colorPicker || otherPopupOpen("TAG_COLOR_TEASER_POPUP", isModalOpen))
			{
				return;
			}
			cancelHide();
			installTagDeleteKeys();
			markTagDeleteHover(tagEl, event);
			const rect = tagEl.getBoundingClientRect();
			pop("TAG_COLOR_TEASER_POPUP", tagEl);
			setTagHover(
				{
					tag: tagEl.textContent,
					top: rect.top,
					right: rect.right,
					bottom: rect.bottom,
					left: rect.left,
				},
			);
		},
		[colorPicker, tagHover, cancelHide, scheduleHide],
	);

	// Upstream: a caret move or an editor blur closes the teaser at once.
	const teaserShown = tagHover !== null;
	useEffect(() =>
	{
		if (!teaserShown)
		{
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		const close = () =>
		{
			cancelHide();
			unpop("TAG_COLOR_TEASER_POPUP");
			setTagHover(null);
		};
		document.addEventListener("selectionchange", close);
		document.addEventListener("focusout", close);
		return () =>
		{
			document.removeEventListener("selectionchange", close);
			document.removeEventListener("focusout", close);
		};
	}, [teaserShown, cancelHide]);

	const openPicker = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) =>
		{
			// Upstream opens on mousedown; preventDefault keeps focus where it was.
			event.preventDefault();
			if (!tagHover)
			{
				return;
			}
			cancelHide();
			pop("TAG_COLORS_POPUP");
			setColorPicker(
				{
					tag: tagHover.tag,
					top: tagHover.bottom,
					left: tagHover.left,
				},
			);
			setTagHover(null);
		},
		[tagHover, cancelHide],
	);

	const closeColorPicker = useCallback(() =>
	{
		unpop("TAG_COLORS_POPUP");
		setColorPicker(null);
	}, []);

	// Close the open picker on a click/escape outside of it.
	useEffect(() =>
	{
		if (!colorPicker)
		{
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		const onPointerDown = (event: PointerEvent) =>
		{
			if (!(event.target instanceof Element && event.target.closest(".tag-color-picker")))
			{
				setColorPicker(null);
			}
		};
		const onKey = closeOnEscape(() =>
		{
			setColorPicker(null);
		});
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKey);
		return () =>
		{
			unpop("TAG_COLORS_POPUP");
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [colorPicker]);

	const popups = (
		<>
			{tagHover &&
				!colorPicker &&
				createPortal(
					// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- upstream's teaser is a pointer-only div
					<div
						aria-label="Set tag color"
						className="tag-color-teaser"
						onMouseDown={openPicker}
						onMouseEnter={cancelHide}
						onMouseLeave={scheduleHide}
						style={teaserStyle(tagHover)}
					>
						<div className="tag-color-teaser-glyph">
							<FaIcon icon="fal:chevron-down" />
						</div>
					</div>,
					document.body,
				)}
			{colorPicker && (
				<RestingTagColorPicker
					left={colorPicker.left}
					onClose={closeColorPicker}
					tag={colorPicker.tag}
					top={colorPicker.top}
				/>
			)}
		</>
	);

	return {
		onClick,
		onMouseDown: preventTagMouseDown,
		onMouseOver,
		onMouseLeave: scheduleHide,
		popups,
	};
}
