/**
 * Pure planners for the slash menu trigger, ported from upstream's `qU4` slash input hook and
 * the `/` symbol predicates (`first`, `standalone`, `propping`).
 */

import {CARD_PLACEHOLDER} from "./dashboard.js";
import {isPropping} from "./suggest/suggest-engine.js";

export const SLASH_CHIP_CLASS = "slash-input bg-tertiary py-2xs pr-xs pl-xs rounded-s leading-none";

export interface SlashRange {
	readonly start: number;
	readonly end: number;
}

const REARM_SCAN_LENGTH = 10;

/**
 * Chip range for a `/` just typed at `slashIndex` of `text`, or null when it does not trigger.
 * Triggers when the slash is `first` (offset 0) or `standalone`; a trailing slash after other text
 * also wraps the preceding character (the space).
 */
export function planSlashOpen(text: string, slashIndex: number): SlashRange | null {
	const first = slashIndex === 0;
	const standalone = !isPropping(text[slashIndex - 1]) && !isPropping(text[slashIndex + 1]);
	if (!first && !standalone) {
		return null;
	}
	const last = slashIndex === text.length - 1;
	const start = last && !first ? slashIndex - 1 : slashIndex;
	return {start, end: slashIndex + 1};
}

/**
 * Range to re-wrap as a chip after a deleting input, scanning back up to 10 characters from the caret
 * for a `/`. The caller must still require a non-empty `resolveSlash` for the text after the slash.
 */
export function planSlashRearm(text: string, caret: number): SlashRange | null {
	const before = text.slice(0, caret);
	for (let o = caret; o > caret - REARM_SCAN_LENGTH && o >= 0; o--) {
		if (before[o] !== "/") {
			continue;
		}
		if ((before[o - 1] !== " " && o !== 0) || before[o + 1] === " ") {
			return null;
		}
		return {start: before[o - 1] === " " ? o - 1 : o, end: caret};
	}
	return null;
}

const SLASH_CHIP_PATTERN = new RegExp(`<span class="${SLASH_CHIP_CLASS}">([^<]*)</span>`, "gu");

/** Unwraps any slash chip span to its plain text so a live chip is never persisted. */
export function stripSlashChip(html: string): string {
	return html.replaceAll(SLASH_CHIP_PATTERN, "$1");
}

const SLASH_HINT = 'Type "/" for commands';

export interface PlaceholderInput {
	readonly focused: boolean;
	readonly empty: boolean;
	readonly layoutMode?: string | null | undefined;
	readonly slashDiscovered?: boolean;
	readonly isZoomRoot?: boolean;
	/** The row is a dashboard card: an empty title reads "Add a title" instead of the slash hint. */
	readonly dashboardCard?: boolean;
}

/** Upstream draws no placeholder (neither the slash hint nor "Untitled") on these rows. */
const NO_PLACEHOLDER_LAYOUTS: ReadonlySet<string> = new Set(["quote", "quote-block", "code-block", "divider"]);

/**
 * Upstream's name placeholder (`doc/plugins/slash-hint` plus the zoom-root title): a focused empty
 * name hints at the slash menu until it is discovered, except on numbered rows; an
 * empty zoom-root title otherwise reads "Untitled". Quote, code and divider rows show neither. The account-age rule is
 * n/a locally.
 */
export function placeholderFor({
	focused,
	empty,
	layoutMode,
	slashDiscovered = true,
	isZoomRoot = false,
	dashboardCard = false,
}: PlaceholderInput): string | undefined {
	if (!empty || NO_PLACEHOLDER_LAYOUTS.has(layoutMode ?? "")) {
		return undefined;
	}
	if (dashboardCard) {
		return CARD_PLACEHOLDER;
	}
	if (focused && !slashDiscovered && layoutMode !== "divider" && layoutMode !== "numbered") {
		return SLASH_HINT;
	}
	return isZoomRoot ? "Untitled" : undefined;
}
