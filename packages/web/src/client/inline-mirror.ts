// The `((` inline mirror popup (upstream MIRROR_SEARCH_POPUP): pure planners for typing `((`, finding the typed query,
// and what choosing a location does to the row.
import {stripHtmlTags} from "@outlinedb/shared/html";
import type {SuggestRange} from "./hooks/use-suggest.js";

export const MIRROR_FROM_HEADER = "mirror from";

/** Opens on the second `(` of `((` just typed at `index`. */
export function planMirrorOpen(text: string, index: number): SuggestRange | null {
	return text[index] === "(" && text[index - 1] === "(" ? {start: index - 1, end: index + 1} : null;
}

/** A resting `((query` that ends at the caret, to re-wrap as a chip after a deletion. */
export function planMirrorRearm(text: string, caret: number): SuggestRange | null {
	const before = text.slice(0, caret);
	const at = before.lastIndexOf("((");
	return at === -1 || before.slice(at).includes("))") ? null : {start: at, end: caret};
}

export type InlineMirrorPlan = {kind: "replace-row"} | {kind: "split"; before: string; after: string};

function isBlank(html: string): boolean {
	return (
		stripHtmlTags(html)
			.replaceAll(/&nbsp;| /gu, "")
			.trim() === ""
	);
}

/**
 * What choosing a location does: a row whose whole name is `((…))` is replaced by the mirror; otherwise the row is
 * split at the chip, the text before it (minus one trailing whitespace) stays and the text after follows the mirror.
 */
export function planInlineMirror({beforeHtml, afterHtml}: {beforeHtml: string; afterHtml: string}): InlineMirrorPlan {
	if (isBlank(beforeHtml) && isBlank(afterHtml)) {
		return {kind: "replace-row"};
	}
	return {kind: "split", before: beforeHtml.replace(/\s$/u, ""), after: afterHtml};
}

/** The palette command `insert_inline_mirror`: `((`, or ` ((` after a non-space. */
export function inlineMirrorInsertion(textBeforeCaret: string): string {
	return textBeforeCaret === "" || /\s$/u.test(textBeforeCaret) ? "((" : " ((";
}

/** Upstream's refusals when the chosen location cannot be mirrored into the row's parent. */
export function inlineMirrorRefusal({
	pickId,
	rowId,
	parentLineage,
}: {
	pickId: string;
	rowId: string;
	/** The row's parent and each of its ancestors. */
	parentLineage: readonly string[];
}): "Cannot mirror Home" | "Cannot mirror an item into itself" | null {
	if (pickId === "None" || pickId === "") {
		return "Cannot mirror Home";
	}
	return pickId === rowId || parentLineage.includes(pickId) ? "Cannot mirror an item into itself" : null;
}
