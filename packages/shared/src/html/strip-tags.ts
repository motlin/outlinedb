const KNOWN_TAGS =
	"a|b|i|u|s|em|strong|span|time|mark|code|pre|br|hr|div|p|ul|ol|li|img|h[1-6]|blockquote|strike|del|font|sub|sup|table|tr|td|th";
const TAG_PATTERN = new RegExp(`</?(?:${KNOWN_TAGS})(?:\\s[^>]*)?/?>`, "giu");

export function stripHtmlTags(html: string | null): string {
	if (!html) {
		return "";
	}
	// Without a tag or an entity there is nothing to strip, and most rows have neither.
	if (!html.includes("<") && !html.includes("&")) {
		return html.trim();
	}
	return html
		.replaceAll(TAG_PATTERN, "")
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.trim();
}
