import {stripHtmlTags} from "../html/strip-tags.js";
import {findTags} from "./tags.js";

/** The text of one item that holds its tags. */
export interface TaggedText {
	name: string | null;
	note: string | null;
	/** A code block's text is plain: its tags never count (upstream's `tagging.ignore.code_block`). */
	layoutMode?: string | null;
}

const TEMPLATE_TAG_PREFIX = "#use-template";

/**
 * An item's distinct tags keyed by their lowercase form, each with its first-seen casing, skipping #use-template
 * tags and code blocks: what upstream's tag index counts once per item.
 */
export function itemTags({name, note, layoutMode}: TaggedText): Map<string, string> {
	const tags = new Map<string, string>();
	if (layoutMode === "code-block") {
		return tags;
	}
	for (const {tag} of findTags(`${stripHtmlTags(name)}\n${stripHtmlTags(note)}`)) {
		const lower = tag.toLowerCase();
		if (!tags.has(lower) && !lower.startsWith(TEMPLATE_TAG_PREFIX)) {
			tags.set(lower, tag);
		}
	}
	return tags;
}
