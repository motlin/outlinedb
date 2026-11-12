// Port of upstream WF.StdFuzzy (re/valid/match/score), used to filter and rank menu labels.

function alphanumeric(term: string): string
{
	return term.replaceAll(/[^A-Za-z0-9]/gu, "");
}

export function fuzzyRegExp(term: string): RegExp
{
	return new RegExp(String.raw`\b${alphanumeric(term).split("").join(".*")}`, "iu");
}

export function fuzzyValid(term: string): boolean
{
	return alphanumeric(term).length > 0;
}

/** Case-insensitive subsequence test; false when either side is empty. */
export function fuzzyMatch(term: string, text: string): boolean
{
	if (!term || !text)
	{
		return false;
	}
	const needle = term.toLowerCase();
	const haystack = text.toLowerCase();
	let matched = 0;
	for (let i = 0; i < haystack.length && matched < needle.length; i++)
	{
		if (haystack[i] === needle[matched])
		{
			matched++;
		}
	}
	return matched === needle.length;
}

/**
 * Upstream scoring: +10 for a matched char at index 0, an uppercase original, or after whitespace;
 * +streak*5 for consecutive matches (else +1); -index*0.01 per matched char; -1 when not fully matched.
 */
export function fuzzyScore(term: string, text: string): number
{
	if (!term || !text)
	{
		return -1;
	}
	const original = text;
	const needle = term.toLowerCase();
	const haystack = text.toLowerCase();
	let matched = 0;
	let score = 0;
	let streak = 0;
	let last = -1;
	for (let i = 0; i < haystack.length && matched < needle.length; i++)
	{
		if (haystack[i] !== needle[matched])
		{
			continue;
		}
		if (i === 0 || original[i] !== haystack[i] || /\s/u.test(original[i - 1] ?? ""))
		{
			score += 10;
		}
		if (last === i - 1)
		{
			streak++;
			score += streak * 5;
		}
		else
		{
			streak = 0;
			score += 1;
		}
		score -= i * 0.01;
		last = i;
		matched++;
	}
	return matched === needle.length ? score : -1;
}
