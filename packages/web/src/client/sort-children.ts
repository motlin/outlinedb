import {parseTimeAttrs} from "@outlinedb/shared";
import {stripHtmlTags} from "@outlinedb/shared/html";

export type SortDirection = "asc" | "desc";

export interface SortableChild {
	id: string;
	name: string;
	movable: boolean;
}

export interface SortMovePlan {
	ids: string[];
	index: 0;
}

/** One link of upstream's comparator chain; `null` defers to the next link. */
type NameComparator = (a: string, b: string) => number | null;

function numericValue(plain: string): number | null {
	const trimmed = plain.trim();
	if (trimmed === "") {
		return null;
	}
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : null;
}

/** Upstream `vP`: numbers compare numerically; a lone number goes first. */
const compareNumeric: NameComparator = (a, b) => {
	const left = numericValue(stripHtmlTags(a));
	const right = numericValue(stripHtmlTags(b));
	if (left !== null && right !== null) {
		return left - right;
	}
	if (left === null && right === null) {
		return null;
	}
	return right === null ? -1 : 1;
};

const LEADING_TIME = /^(?:\s|<(?!time\b)[^>]*>)*<time\b([^>]*)>/iu;

function leadingDate(name: string): number | undefined {
	const match = LEADING_TIME.exec(name);
	if (match?.[1] === undefined) {
		return undefined;
	}
	const {startYear, startMonth, startDay, startHour = 0, startMinute = 0} = parseTimeAttrs(match[1]);
	return new Date(startYear, startMonth - 1, startDay, startHour, startMinute).getTime();
}

/** Upstream `yP`: names starting with a date compare by it; dated before undated. */
const compareLeadingDate: NameComparator = (a, b) => {
	const left = leadingDate(a);
	const right = leadingDate(b);
	if (left !== undefined && right !== undefined) {
		return left - right;
	}
	if (left === undefined && right === undefined) {
		return null;
	}
	return right === undefined ? -1 : 1;
};

/** Upstream `go`, kept verbatim: only the right side is lowercased. */
const comparePlainText: NameComparator = (a, b) => stripHtmlTags(a).localeCompare(stripHtmlTags(b).toLowerCase());

/** Extend this chain for further sort kinds (e.g. by creation date). */
const NAME_COMPARATORS: readonly NameComparator[] = [compareNumeric, compareLeadingDate, comparePlainText];

/** Upstream sort order: the first comparator with a result wins; Z-A negates it. */
function compareChildNames(a: string, b: string, direction: SortDirection): number {
	for (const comparator of NAME_COMPARATORS) {
		const result = comparator(a, b);
		if (result !== null) {
			return direction === "desc" ? -result : result;
		}
	}
	return 0;
}

export function sortChildNames(names: readonly string[], direction: SortDirection): string[] {
	return names.toSorted((a, b) => compareChildNames(a, b, direction));
}

/**
 * The one block move that sorts a parent's children: the movable children, sorted, under the
 * parent at index 0, so unmovable children end up last. Null when nothing would change.
 */
export function planSortMove(children: readonly SortableChild[], direction: SortDirection): SortMovePlan | null {
	const ids = children
		.filter((child) => child.movable)
		.toSorted((a, b) => compareChildNames(a.name, b.name, direction))
		.map((child) => child.id);
	const alreadyLeading = ids.every((id, index) => children[index]?.id === id);
	return alreadyLeading ? null : {ids, index: 0};
}

export interface SortMoveRequest {
	ids: string[];
	parent_id: string;
	index: 0;
}

export interface SortToast {
	text: string;
	timeout: number;
	undoLabel: string;
	undo: () => void;
}

const SORT_TOAST_TEXT: Record<SortDirection, string> = {asc: "Sorted A-Z", desc: "Sorted Z-A"};

/**
 * Upstream Sort A-Z / Z-A: one block move of the sorted children, then a 5s toast whose Undo pops the undo stack
 * (upstream `WF.Undo.undo`, which waits for the move to land). Returns what `moveNodes` returned (the in-flight move).
 */
export function runSortChildren<T>({
	parentId,
	children,
	direction,
	moveNodes,
	showToast,
	undo,
}: {
	parentId: string;
	children: readonly SortableChild[];
	direction: SortDirection;
	moveNodes: (request: SortMoveRequest) => T;
	showToast: (toast: SortToast) => void;
	/** Pops the undo stack (the toast's Undo). */
	undo: () => void;
}): T | undefined {
	const plan = planSortMove(children, direction);
	if (plan === null) {
		return undefined;
	}
	const sent = moveNodes({ids: plan.ids, parent_id: parentId, index: 0});
	showToast({text: SORT_TOAST_TEXT[direction], timeout: 5000, undoLabel: "Undo", undo});
	return sent;
}
