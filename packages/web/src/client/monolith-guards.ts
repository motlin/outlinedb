// Upstream puts a U+FEFF text node outside a monolith pill (`<time>` / `<mention>`) that starts
// or ends the content, so the caret has somewhere to stand next to it.

const BOM = "﻿";
const MONOLITH = String.raw`<(?:time|mention)\b[^>]*data-monolith[^>]*>[\s\S]*?<\/(?:time|mention)>`;
const STARTS_WITH_MONOLITH = new RegExp(String.raw`^(?:<[a-z][^>]*>)*${MONOLITH}`, "iu");
const ENDS_WITH_MONOLITH = new RegExp(String.raw`${MONOLITH}(?:<\/[a-z][^>]*>)*$`, "iu");

/** `html` with a leading and/or trailing U+FEFF where a monolith pill starts or ends the content. */
export function addMonolithGuards(html: string): string
{
	return `${STARTS_WITH_MONOLITH.test(html) ? BOM : ""}${html}${ENDS_WITH_MONOLITH.test(html) ? BOM : ""}`;
}
