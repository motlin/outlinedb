/**
 * Display-time auto-linking ported from upstream's wf-base bundle: bare URLs and domains
 * (`TT`), email addresses (`Gn1`), and NANP phone numbers (`Vn1`) render as `.contentLink`
 * anchors without the stored text carrying `<a>`. Ranges are plain-text offsets.
 */

export interface UrlMatch
{
	start: number;
	end: number;
	href: string;
}

export interface TextMatch
{
	start: number;
	end: number;
	text: string;
}

const LETTER_DIGIT = String.raw`\p{L}\p{Nd}`;
const SYMBOL = "(©|®|[ -㌀]|\uD83C[퀀-\uDFFF]|\uD83D[퀀-\uDFFF]|\uD83E[퀀-\uDFFF])";
const PUNCTUATION = String.raw`[(),.!?';:\/\[\]]`;
const URL_TRIGGER_PATTERN = new RegExp(
	String.raw`://|message:<|message:%3C|\.([a-z]{2}[a-z]*)(?=$|[^.\-${LETTER_DIGIT}]|\.$|\.[^${LETTER_DIGIT}])`,
	"giu",
);
const LABEL = `[${LETTER_DIGIT}]([${LETTER_DIGIT}\\-_]*[${LETTER_DIGIT}])?`;
const DOMAIN_PATTERN = new RegExp(`^${LABEL}(\\.${LABEL})*$`, "iu");
const DOMAIN_CHAR_PATTERN = new RegExp(`[${LETTER_DIGIT}.\\-_]`, "iu");
const URL_END_CHARS = `${LETTER_DIGIT}\\/:#?&%=~;$@\\-_+!*'(){}`;
const URL_INNER_CHARS = `${URL_END_CHARS}.,`;
const URL_REST_PATTERN = new RegExp(`^(([\\[\\]${URL_INNER_CHARS}]|${SYMBOL})*([${URL_END_CHARS}]|${SYMBOL}))`, "iu");
const SCHEME_CHAR_PATTERN = /[a-z0-9\-+.]/iu;
const EMAIL_LOCAL_CHAR_PATTERN = /[a-z0-9._%+-]/iu;
const EMAIL_DOMAIN_PATTERN = /^[a-z0-9]+[a-z0-9\-.]*\.[a-z]+/iu;
const PHONE_SEPARATOR = String.raw`[\-.]`;
const PHONE_AREA = "[2-9][0-9][0-9]";
const PHONE_PATTERN = new RegExp(
	`(^|\\s|${PUNCTUATION})((\\+?1${PHONE_SEPARATOR})?(\\(${PHONE_AREA}\\)|${PHONE_AREA})${PHONE_SEPARATOR}${PHONE_AREA}${PHONE_SEPARATOR}[0-9]{4})(?=$|\\s|${PUNCTUATION})`,
	"gu",
);

const TLDS = new Set(
	`AC AD AE AERO AF AG AI AL AM AN AO AQ AR ARPA AS ASIA AT AU AW AX AZ BA BB BD BE BF BG BH BI BIZ BJ BM BN BO BR BS BT BV BW BY BZ CA CAT CC CD CF CG CH CI CK CL CM CN CO COM COOP CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EDU EE EG ER ES ET EU FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GOV GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN INFO INT IO IQ IR IS IT JE JM JO JOBS JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MIL MK ML MM MN MO MOBI MP MQ MR MS MT MU MUSEUM MV MW MX MY MZ NA NAME NC NE NET NF NG NI NL NO NP NR NU NZ OM ORG PA PE PF PG PH PK PL PM PN POST PR PRO PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR ST SU SV SX SY SZ TC TD TEL TF TG TH TJ TK TL TM TN TO TP TR TRAVEL TT TV TW TZ UA UG UK US UY UZ VA VC VE VG VI VN VU WF WS XXX YE YT ZA ZM ZW`.split(
		" ",
	),
);
// TLDs that read as file extensions: a bare `notes.md` is not linked unless it has a scheme.
const FILE_LIKE_TLDS = new Set(["PY", "PL", "RS", "SH", "MD", "NAME", "ID"]);

function openParenCount(text: string): number
{
	let count = 0;
	for (const char of text)
	{
		if (char === "(")
		{
			count += 1;
		}
		else if (char === ")" && count > 0)
		{
			count -= 1;
		}
	}
	return count;
}

/** Drops a trailing `)` that closes a paren opened before the URL. */
function trimUnbalancedParen(rest: string): string
{
	if (rest.endsWith(")"))
	{
		const trimmed = rest.slice(0, -1);
		if (openParenCount(trimmed) === 0)
		{
			return trimmed;
		}
	}
	return rest;
}

function isExcluded(url: string): boolean
{
	const tld = (url.split(".").pop() ?? "").toUpperCase();
	return (
		url === "m.sc" ||
		url === "http://www" ||
		url === "https://www" ||
		(FILE_LIKE_TLDS.has(tld) && !url.startsWith("http"))
	);
}

function urlRest(text: string): string | null
{
	const match = URL_REST_PATTERN.exec(text);
	return match === null ? null : trimUnbalancedParen(match[0]);
}

function locateUrl(
	text: string,
	match: RegExpExecArray,
):
{
	start: number;
	end: number;
	hasScheme: boolean;
} | null
{
	const [trigger] = match;
	const index = match.index;
	if (trigger === "://")
	{
		let start = index;
		while (start > 0 && SCHEME_CHAR_PATTERN.test(text.charAt(start - 1)))
		{
			start -= 1;
		}
		while (start < index && !/[a-z]/iu.test(text.charAt(start)))
		{
			start += 1;
		}
		if (start === index || /^javascript$/iu.test(text.slice(start, index)))
		{
			return null;
		}
		const restStart = index + trigger.length;
		const rest = urlRest(text.slice(restStart));
		return rest === null
			? null
			:
				{
					start,
					end: restStart + rest.length,
					hasScheme: true,
				};
	}
	if (trigger === "message:<" || trigger === "message:%3C")
	{
		const close = trigger === "message:%3C" ? "%3E" : ">";
		const closeIndex = text.indexOf(close, index + trigger.length);
		return closeIndex === -1
			? null
			:
				{
					start: index,
					end: closeIndex + close.length,
					hasScheme: true,
				};
	}
	if (match[1] === undefined || !TLDS.has(match[1].toUpperCase()))
	{
		return null;
	}
	let start = index;
	while (start > 0 && DOMAIN_CHAR_PATTERN.test(text.charAt(start - 1)))
	{
		start -= 1;
	}
	if (!DOMAIN_PATTERN.test(text.slice(start, index)))
	{
		return null;
	}
	const after = index + trigger.length;
	const next = text.charAt(after);
	if (next !== "" && /\w/u.test(next))
	{
		return null;
	}
	if (next !== "/")
	{
		return {
			start,
			end: after,
			hasScheme: false,
		};
	}
	return {
		start,
		end: after + (urlRest(text.slice(after)) ?? "").length,
		hasScheme: false,
	};
}

/** Upstream `TT`: every URL or bare domain in plain text, with the href it links to. */
export function findUrls(text: string): UrlMatch[]
{
	const matches: UrlMatch[] = [];
	URL_TRIGGER_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = URL_TRIGGER_PATTERN.exec(text)) !== null)
	{
		const located = locateUrl(text, match);
		if (located === null)
		{
			continue;
		}
		const url = text.slice(located.start, located.end);
		if (!isExcluded(url))
		{
			matches.push(
				{
					start: located.start,
					end: located.end,
					href: located.hasScheme ? url : `http://${url}`,
				},
			);
		}
		URL_TRIGGER_PATTERN.lastIndex = located.end;
	}
	return matches;
}

/** Upstream `Gn1`: every email address in plain text. */
export function findEmails(text: string): TextMatch[]
{
	const matches: TextMatch[] = [];
	let cursor = 0;
	while ((cursor = text.indexOf("@", cursor)) >= 0)
	{
		const at = cursor;
		cursor += 1;
		let start = at;
		while (start > 0 && EMAIL_LOCAL_CHAR_PATTERN.test(text.charAt(start - 1)))
		{
			start -= 1;
		}
		if (start === at)
		{
			continue;
		}
		const domain = EMAIL_DOMAIN_PATTERN.exec(text.slice(cursor));
		if (domain === null)
		{
			continue;
		}
		cursor += domain[0].length;
		if (text.charAt(cursor) !== ">")
		{
			matches.push(
				{
					start,
					end: cursor,
					text: text.slice(start, cursor),
				},
			);
		}
	}
	return matches;
}

/** Upstream `Vn1`: every NANP phone number bounded by whitespace or punctuation. */
export function findPhoneNumbers(text: string): TextMatch[]
{
	return [...text.matchAll(PHONE_PATTERN)].map((match) =>
	{
		const start = match.index + (match[1] ?? "").length;
		const number = match[2] ?? "";
		return {
			start,
			end: start + number.length,
			text: number,
		};
	});
}

function decodeHrefEntities(href: string): string
{
	return href
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");
}

/** The href a found URL links to: entities decoded, then URI-encoded when it does not parse. */
function normalizeUrlHref(href: string): string
{
	const decoded = decodeHrefEntities(href);
	if (URL.canParse(decoded))
	{
		return decoded;
	}
	try
	{
		return encodeURI(decoded);
	}
	catch
	{
		return decoded;
	}
}

export interface AutoLink
{
	start: number;
	end: number;
	href: string;
}

function intersects(
	start: number,
	end: number,
	ranges: readonly
	{
		start: number;
		end: number;
	}[],
): boolean
{
	return ranges.some((range) => start < range.end && range.start < end);
}

/**
 * Every auto-link in plain text, in upstream's locate order: emails, then phone numbers,
 * then URLs, each skipping ranges an earlier one claimed or `blocked` covers.
 */
export function findAutoLinks(
	text: string,
	blocked: readonly
	{
		start: number;
		end: number;
	}[],
): AutoLink[]
{
	const links: AutoLink[] = [];
	const claim = (start: number, end: number, href: string): void =>
	{
		if (!intersects(start, end, blocked) && !intersects(start, end, links))
		{
			links.push(
				{
					start,
					end,
					href,
				},
			);
		}
	};
	for (const {start, end, text: email} of findEmails(text))
	{
		claim(start, end, `mailto:${email}`);
	}
	for (const {start, end, text: phone} of findPhoneNumbers(text))
	{
		claim(start, end, `tel:${phone}`);
	}
	for (const {start, end, href} of findUrls(text))
	{
		claim(start, end, normalizeUrlHref(href));
	}
	return links.toSorted((a, b) => a.start - b.start);
}
