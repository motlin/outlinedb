import {useCallback, useRef, useState} from "react";
import type {ReactNode} from "react";
import {createPortal} from "react-dom";
import {formatPillLabel, guessDates, presetDate} from "@outlinedb/shared";
import type {DatePreset, TimeAttrs} from "@outlinedb/shared";
import {unitsBefore} from "../caret-dom.js";
import {timeAttrsFromDates} from "../date-pills.js";
import type {DateSettings} from "../date-settings.js";
import {outlineActions} from "../stores/outline.js";
import {CalendarDatePickerPopup} from "./date-picker-popup.js";

interface OpenPill {
	pillIndex: number;
	position: {left: number; top: number};
	term: string;
	isRange: boolean;
}

/**
 * The date pill a plain click (no modifier: ⌥click is reserved for date search) landed on inside
 * `root`, with its index among `root`'s pills, or null.
 */
export function clickedPill(event: React.MouseEvent, root: Element): {pill: Element; index: number} | null {
	const pill = event.target instanceof Element ? event.target.closest("time.monolith-pill") : null;
	if (pill === null || !root.contains(pill) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return null;
	}
	return {pill, index: [...root.querySelectorAll("time.monolith-pill")].indexOf(pill)};
}

/** Plain-text units (a pill counting one) from the start of `root` to just after `pill`. */
export function offsetAfterPill(root: HTMLElement, pill: Element): number {
	const parent = pill.parentNode;
	return parent === null ? 0 : unitsBefore(root, parent, [...parent.childNodes].indexOf(pill) + 1);
}

interface PillDatePickerOptions {
	dateSettings: DateSettings;
	/** Replace the `pillIndex`-th pill with `attrs`, or remove it when `attrs` is null, and save. */
	onChange: (pillIndex: number, attrs: TimeAttrs | null) => void;
	/** The picker closed without changing the pill (Escape, an outside click, Enter with no date, or Format). */
	onDismiss?: () => void;
}

/**
 * Upstream's click-a-pill editor: opens the date picker under a pill in a name or note, at rest or being edited, with its
 * label prefilled (so the grid opens on its month with the day selected) and "Remove date".
 * Enter with a parsed date, a preset or a day click replaces the pill; Remove date deletes it.
 */
export function usePillDatePicker({dateSettings, onChange, onDismiss}: PillDatePickerOptions): {
	open: (pill: Element, pillIndex: number) => void;
	popup: ReactNode;
} {
	const [picker, setPicker] = useState<OpenPill | null>(null);
	// Applying refocuses the editor, whose blur of the picker input would otherwise report a dismissal too.
	const isOpen = useRef(false);
	const {openSettings} = outlineActions();

	const open = useCallback((pill: Element, pillIndex: number) => {
		const rect = pill.getBoundingClientRect();
		const label = pill.textContent.replaceAll("﻿", "");
		isOpen.current = true;
		setPicker({
			pillIndex,
			position: {left: rect.left + globalThis.scrollX, top: rect.bottom + globalThis.scrollY},
			term: label,
			isRange: pill.hasAttribute("endyear"),
		});
	}, []);

	const close = useCallback(() => {
		isOpen.current = false;
		setPicker(null);
	}, []);

	const dismiss = useCallback(() => {
		if (!isOpen.current) {
			return;
		}
		close();
		onDismiss?.();
	}, [close, onDismiss]);

	const popup = (() => {
		if (picker === null) {
			return null;
		}
		const guess = guessDates(picker.term, {
			dateFormat: dateSettings.dateFormat,
			weekStartDay: dateSettings.weekStartDay,
		});
		const apply = (dates: Date[]) => {
			close();
			onChange(picker.pillIndex, timeAttrsFromDates(dates));
		};
		return createPortal(
			<CalendarDatePickerPopup
				selected={guess}
				weekStartDay={dateSettings.weekStartDay}
				isRange={picker.isRange}
				showNoDate
				term={picker.term}
				position={picker.position}
				onTermChange={(term) => {
					setPicker({...picker, term});
				}}
				onEnter={() => {
					if (guess.length > 0) {
						apply(guess);
					} else {
						dismiss();
					}
				}}
				onApply={(dates) => {
					const [first] = dates;
					if (picker.isRange && dates.length === 1 && first !== undefined) {
						// A range's first click only fills the input; the second replaces the pill with the sorted range.
						setPicker({
							...picker,
							term: formatPillLabel(timeAttrsFromDates([first]), {dateFormat: dateSettings.dateFormat}),
						});
					} else {
						apply(dates);
					}
				}}
				onPreset={(preset: DatePreset) => {
					apply([presetDate(preset, {weekStartDay: dateSettings.weekStartDay})]);
				}}
				onToggleRange={() => {
					setPicker({...picker, isRange: !picker.isRange});
				}}
				onFormat={() => {
					dismiss();
					openSettings("Dates");
				}}
				onRemove={() => {
					close();
					onChange(picker.pillIndex, null);
				}}
				onEscape={dismiss}
				onClose={dismiss}
			/>,
			document.body,
		);
	})();
	return {open, popup};
}
