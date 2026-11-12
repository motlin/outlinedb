import {useCallback, useEffect, useRef, useState} from "react";
import type {ReactNode} from "react";
import {createPortal} from "react-dom";
import {formatPillLabel} from "@outlinedb/shared";
import type {DatePhrase} from "@outlinedb/shared";
import {caretTextOffset} from "../caret-dom.js";
import {datePhraseText, findDatePhraseAtCaret, serializeDatePills} from "../date-pills.js";
import type {DateSettings} from "../date-settings.js";
import {isFeatureOn} from "../features.js";
import {isVisible, pop, unpop} from "../popups.js";
import {FaIcon} from "./fa-icons.js";
import {popoverBox} from "./flyout/popover-box.js";
import {IconButton} from "./icon-button.js";

/** Upstream places the flyout 20px below the phrase's top edge. */
const FLYOUT_DROP = 20;

interface Position
{
	left: number;
	top: number;
}

export interface DateAutocompleteFlyoutProps
{
	label: string;
	/** Page position of the phrase's top-left corner. */
	position: Position;
	onApply: () => void;
	onOpenPicker: () => void;
	onOpenSettings: () => void;
}

/** Upstream's `xi1` flyout: the parsed date's label, the full-picker and Settings > Dates buttons, and the Tab hint. */
export function DateAutocompleteFlyout({
	label,
	position,
	onApply,
	onOpenPicker,
	onOpenSettings,
}: DateAutocompleteFlyoutProps)
{
	const box = popoverBox(
		{
			maxWidth: 240,
			offset: [0, 0],
		},
	);
	return (
		// oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keeps the editor focused while the flyout is clicked
		<div
			className={`${box.className} absolute flyout !pt-s !pb-m !px-m text-center gap-m`}
			style={
			{
				...box.style,
				left: position.left,
				top: position.top + FLYOUT_DROP,
			}}
			onMouseDown={(event) =>
			{
				event.preventDefault();
			}}
		>
			<div className="flex items-center gap-m justify-between text-xs">
				<span>{label}</span>
				<div className="flex flex-row">
					<IconButton icon="calendar-alt" size="md" shape="square" onClick={onOpenPicker}>
						<FaIcon icon="fal:calendar-days" />
					</IconButton>
					<IconButton icon="gear" size="md" shape="square" onClick={onOpenSettings}>
						<FaIcon icon="fal:gear" />
					</IconButton>
				</div>
			</div>
			{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- upstream's click target; Tab is the keyboard path */}
			<p className="text-xs" onClick={onApply}>
				Press <span className="tooltip-key">Tab</span> or click here
			</p>
		</div>
	);
}

/** Upstream checks only `key === "Tab"` (so Shift+Tab converts too); any other keydown hides the flyout. */
export function dateAutocompleteKeyAction(event: {key: string; shiftKey: boolean}): "apply" | "hide"
{
	return event.key === "Tab" ? "apply" : "hide";
}

interface Shown
{
	phrase: DatePhrase;
	position: Position;
}

interface DateAutocompleteOptions
{
	editorRef: React.RefObject<HTMLElement | null>;
	dateSettings: DateSettings;
	/** True while another date popup is open, when the flyout must not appear. */
	isBlocked: () => boolean;
	/** Replace the phrase with its pill plus one space and save. */
	onApply: (phrase: DatePhrase) => void;
	/** Open the full date picker for the phrase. */
	onOpenPicker: (phrase: DatePhrase, position: Position) => void;
	onOpenSettings: () => void;
}

/** The page rect of `length` characters ending at the caret, or the caret itself; null without a selection. */
function phrasePosition(length: number): Position | null
{
	const selection = globalThis.getSelection();
	const caret = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
	if (!caret)
	{
		return null;
	}
	const range = caret.cloneRange();
	if (caret.startContainer.nodeType === Node.TEXT_NODE)
	{
		range.setStart(caret.startContainer, Math.max(0, caret.startOffset - length));
	}
	const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
	return {
		left: rect.left + globalThis.scrollX,
		top: rect.top + globalThis.scrollY,
	};
}

/**
 * Upstream's `editor.input.date-autocomplete`: after each input with no date popup open, a
 * natural-language date phrase at the caret shows a flyout; Tab (capture phase, so the row is
 * not indented) or a click converts it to a pill. Any other keydown, or a blur, hides it.
 */
export function useDateAutocomplete({
	editorRef,
	dateSettings,
	isBlocked,
	onApply,
	onOpenPicker,
	onOpenSettings,
}: DateAutocompleteOptions):
{
	handleInput: () => void;
	hide: () => void;
	flyout: ReactNode;
}
{
	const [shown, setShown] = useState<Shown | null>(null);
	const shownRef = useRef<Shown | null>(null);

	const show = useCallback((next: Shown | null) =>
	{
		shownRef.current = next;
		if (next === null)
		{
			unpop("date.autocomplete");
		}
		else
		{
			pop("date.autocomplete");
		}
		setShown(next);
	}, []);
	const hide = useCallback(() =>
	{
		if (shownRef.current !== null)
		{
			show(null);
		}
	}, [show]);

	const handleInput = useCallback(() =>
	{
		const editor = editorRef.current;
		const selection = globalThis.getSelection();
		// Upstream: drop our own slot first, then yield to any other registered popup.
		unpop("date.autocomplete");
		if (editor === null || !isFeatureOn("dates") || isBlocked() || isVisible() || !selection?.isCollapsed)
		{
			hide();
			return;
		}
		const caret = caretTextOffset(editor);
		const phrase = findDatePhraseAtCaret(
			datePhraseText(serializeDatePills(editor.innerHTML)),
			caret,
			new Date(),
			{
				dateFormat: dateSettings.dateFormat,
				weekStartDay: dateSettings.weekStartDay,
			},
		);
		const position = phrase && phrasePosition(caret - phrase.start);
		show(
			phrase && position
				?
					{
						phrase,
						position,
					}
				: null,
		);
	}, [editorRef, isBlocked, hide, show, dateSettings.dateFormat, dateSettings.weekStartDay]);

	const apply = useCallback(() =>
	{
		const current = shownRef.current;
		show(null);
		if (current !== null)
		{
			onApply(current.phrase);
		}
	}, [onApply, show]);

	const isShown = shown !== null;
	useEffect(() =>
	{
		if (!isShown)
		{
			return () =>
			{
			};
		}
		const onKeyDown = (event: KeyboardEvent) =>
		{
			if (dateAutocompleteKeyAction(event) === "apply")
			{
				event.stopImmediatePropagation();
				event.preventDefault();
				apply();
			}
			else
			{
				hide();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () =>
		{
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [isShown, apply, hide]);

	const flyout =
		shown === null
			? null
			: createPortal(
					<DateAutocompleteFlyout
						label={formatPillLabel(
							shown.phrase.attrs,
							{
								dateFormat: dateSettings.dateFormat,
								timeFormat: dateSettings.timeFormat,
							},
						)}
						position={shown.position}
						onApply={apply}
						onOpenPicker={() =>
						{
							show(null);
							onOpenPicker(
								shown.phrase,
								{
									left: shown.position.left,
									top: shown.position.top + FLYOUT_DROP,
								},
							);
						}}
						onOpenSettings={() =>
						{
							show(null);
							onOpenSettings();
						}}
					/>,
					document.body,
				);
	return {
		handleInput,
		hide,
		flyout,
	};
}
