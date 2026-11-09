import {htmlToText} from "@outlinedb/shared/html";

/** Upstream's `config("location").autotitle.noname`. */
export const NONAME_TITLE = "OutlineDB - Organize your brain.";

const MAX_LABEL = 100;

/** Upstream's `BE1`: `<rendered name> - WorkFlowy`, the noname title for an empty label, 100 chars at most. */
export function documentTitleFor(nameHtml: string | null | undefined, render?: (html: string) => string): string {
	const html = nameHtml ?? "";
	const label = htmlToText(render === undefined ? html : render(html));
	if (label === "") {
		return NONAME_TITLE;
	}
	const shown = label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL)}...` : label;
	return `${shown} - OutlineDB`;
}

export interface TitleState {
	/** undefined before the first title. */
	zoomId: string | null | undefined;
	title: string | null;
}

/** The new title, or null to keep the old one. Upstream retitles on navigation only, never on a rename. */
export function nextTitle(
	prev: TitleState,
	next: {zoomId: string | null; nameHtml: string | null | undefined},
	render?: (html: string) => string,
): string | null {
	if (prev.title !== null && prev.zoomId === next.zoomId) {
		return null;
	}
	return documentTitleFor(next.nameHtml, render);
}
