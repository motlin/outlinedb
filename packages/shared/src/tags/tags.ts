export interface FoundTag
{
	index: number;
	tag: string;
}

export const TAG_WITH_BOUNDARY_REGEXP =
	/(^|\s|[(),.!?;:/[\]])([#@]([^(),.!?;:/[\]\s]+(:([^(),.!?;:/[\]\s]+))*))(?=$|\s|[(),.!?;:/[\]])/giu;

export const TAG_AT_END_REGEXP = /(^|\s|[(),.!?;:/[\]])(#[^(),.!?;:/[\]\s]+(:[^(),.!?;:/[\]\s]*)*)$/iu;

const URL_REGEXP = /(https?:\/\/|www\.)\S+/giu;

const MIN_NUMERIC_TAG_LENGTH = 4;

function isShortNumericTag(tag: string): boolean
{
	const body = tag.slice(1);
	return /^\d+$/u.test(body) && body.length < MIN_NUMERIC_TAG_LENGTH;
}

function urlRanges(plainText: string): [number, number][]
{
	return [...plainText.matchAll(URL_REGEXP)].map((match) => [match.index, match.index + match[0].length]);
}

export function findTags(
	plainText: string,
	{
		skipUrls = true,
	}:
	{
		skipUrls?: boolean;
	} = {},
): FoundTag[]
{
	const ranges = skipUrls ? urlRanges(plainText) : [];
	const tags: FoundTag[] = [];
	for (const match of plainText.matchAll(TAG_WITH_BOUNDARY_REGEXP))
	{
		const [, boundary = "", tag = ""] = match;
		const index = match.index + boundary.length;
		const insideUrl = ranges.some(([start, end]) => index >= start && index < end);
		if (!isShortNumericTag(tag) && !insideUrl)
		{
			tags.push(
				{
					index,
					tag,
				},
			);
		}
	}
	return tags;
}

export function getEndingTagText(textBeforeCaret: string): string | undefined
{
	const tag = TAG_AT_END_REGEXP.exec(textBeforeCaret)?.[2];
	if (tag !== undefined)
	{
		return tag;
	}
	return textBeforeCaret.endsWith("#") ? "#" : undefined;
}
