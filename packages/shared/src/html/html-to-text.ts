const TAG = /<[^>]*>/gu;

/** The rendered text of name HTML: tags removed, entities decoded. Unlike `stripHtmlTags` it never trims. */
export function htmlToText(html: string | null | undefined): string
{
	if (!html)
	{
		return "";
	}
	return html
		.replaceAll(TAG, "")
		.replaceAll("&nbsp;", " ")
		.replaceAll(/&#x([\da-f]+);/giu, (_, hex: string) => String.fromCodePoint(Math.trunc(Number(`0x${hex}`))))
		.replaceAll(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(Math.trunc(Number(dec))))
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&");
}
