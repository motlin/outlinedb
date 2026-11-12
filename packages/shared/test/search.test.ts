import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {
	parseQuery,
	matchNested,
	foldPerCharacter,
	normalizeForSearch,
	normalizeWithOffsets,
	parseNestedQuery,
	matchField,
	matchSwitcherRow,
	splitIntoWords,
	indexText,
	resolveJoinedSec,
	staticScore,
	textFactor,
	withMonthNames,
} from "../src/search/index.js";
import {
	searchItem,
	SO_ROWS,
	SO_PLAIN_NAMES,
	SO_PLAIN_NAMES as PLAIN_NAMES,
	searchItem as item,
} from "./helpers/search-so-fixture.js";
import {sinceTimestamp} from "../src/search/operators/time.js";
import type {SearchItem, StaticScoreInput} from "../src/search/index.js";
import {parseSearchQuery} from "../src/search/query-parser.js";

describe("search operators dates", () => {
	const NOW = new Date(2026, 9, 1, 12).getTime();

	function names(query: string, dateFormat?: string): string[] {
		const node = parseQuery(query, dateFormat === undefined ? {now: NOW} : {now: NOW, dateFormat});
		return SO_ROWS.filter((row) => node.matches(row).matches).map((row) => row.nameHtml.split(" ")[0] ?? "");
	}

	describe("explicit date operators", () => {
		it("date:past and date:future compare row starts to today's start and now", () => {
			expect([names("date:past"), names("date:future"), names("has:date")]).toStrictEqual([
				["Past"],
				["Future"],
				["Meeting", "Past", "Future"],
			]);
		});

		it("date:, date-before: and date-after: strictly parse the default YYYY-MM-DD format", () => {
			expect([
				names("date:2026-10-01"),
				names("date:2026-10-1"),
				names("date:26-10-01"),
				names("date-before:2026-10-01"),
				names("date-after:2026-10-01"),
				names("date:10/1/2026"),
				names("date:garbage"),
			]).toStrictEqual([["Meeting"], ["Meeting"], ["Meeting"], ["Past"], ["Future"], [], []]);
		});

		it("date: honours a custom date format and an @HH:mm time", () => {
			const timed = searchItem(
				'Timed <time startYear="2026" startMonth="10" startDay="1" startHour="9" startMinute="30">Oct 1 9:30</time>',
			);
			expect([
				names("date:10/1/2026", "MM/DD/YYYY"),
				parseQuery("date:2026-10-01@09:30", {now: NOW}).matches(timed),
				parseQuery("date:2026-10-01", {now: NOW}).matches(timed).matches,
			]).toStrictEqual([
				["Meeting"],
				{matches: true, nameMatches: false, noteMatches: false, metaMatches: true},
				false,
			]);
		});

		it("date: matches a range end at midnight", () => {
			const range = searchItem(
				'Trip <time startYear="2026" startMonth="10" startDay="5" endYear="2026" endMonth="10" endDay="9">Oct 5 - 9</time>',
			);
			expect([
				parseQuery("date:2026-10-09", {now: NOW}).matches(range).matches,
				parseQuery("date:2026-10-07", {now: NOW}).matches(range).matches,
			]).toStrictEqual([true, false]);
		});

		it("day-of-week: takes full lowercase English day names only", () => {
			expect([
				names("day-of-week:thursday"),
				names("day-of-week:friday"),
				names("day-of-week:thu"),
			]).toStrictEqual([["Meeting"], ["Future"], []]);
		});

		it("negating a date operator requires the row to contain a date", () => {
			expect([names("-date:past"), names("-date:garbage")]).toStrictEqual([
				["Meeting", "Future"],
				["Meeting", "Past", "Future"],
			]);
		});
		it("bare natural-language dates match rows sharing a known date component", () => {
			expect(
				[
					"today",
					"oct 1",
					"this month",
					"Thursday",
					"last month",
					"sep 15",
					"tomorrow",
					"next week",
					"yesterday",
				].map((query) => names(query)),
			).toStrictEqual([["Meeting"], ["Meeting"], ["Meeting"], ["Meeting"], ["Past"], ["Past"], [], [], []]);
		});

		it("a bare date claims a multi-word span, combines with terms, and negation requires a date", () => {
			expect([names("oct 1 meeting"), names("next week -alpha"), names("-today"), names("#today")]).toStrictEqual(
				[["Meeting"], [], ["Past", "Future"], []],
			);
		});
	});

	describe("bare dates use the upstream chrono v1 search instance", () => {
		const FRIDAY = new Date(2026, 9, 23, 20, 30);

		function row(month: number, day: number, time?: string): ReturnType<typeof searchItem> {
			const [hour, minute] = time === undefined ? [] : time.split(":");
			const timeAttrs = time === undefined ? "" : ` startHour="${hour}" startMinute="${minute}"`;
			const label = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}${time === undefined ? "" : `@${time}`}`;
			return searchItem(
				`${label} <time startYear="2026" startMonth="${month}" startDay="${day}"${timeAttrs}>x</time>`,
			);
		}

		const rows = [
			...Array.from({length: 33}, (_unused, offset) => new Date(2026, 9, 7 + offset)).map((date) =>
				row(date.getMonth() + 1, date.getDate()),
			),
			row(11, 23),
			row(10, 23, "15:00"),
			row(10, 24, "15:00"),
			row(10, 23, "22:00"),
		];

		function matched(query: string, options: {now?: Date; weekStartDay?: 0 | 1} = {}): string[] {
			const node = parseQuery(query, {
				now: (options.now ?? FRIDAY).getTime(),
				...(options.weekStartDay === undefined ? {} : {weekStartDay: options.weekStartDay}),
			});
			return rows.filter((each) => node.matches(each).matches).map((each) => each.nameHtml.split(" ")[0] ?? "");
		}

		const week = (from: number, to: number) =>
			Array.from({length: to - from + 1}, (_unused, offset) => `10-${from + offset}`);

		afterEach(() => {
			vi.useRealTimers();
		});

		it("resolves a bare weekday matching today to today", () => {
			expect(matched("friday")).toStrictEqual(["10-23", "10-23@15:00", "10-23@22:00"]);
		});

		it("resolves last friday to the previous week", () => {
			expect(matched("last friday")).toStrictEqual(["10-16"]);
		});

		it("matches every row in a bare month name", () => {
			expect(matched("oct")).toStrictEqual(
				rows.map((each) => each.nameHtml.split(" ")[0] ?? "").filter((label) => label.startsWith("10-")),
			);
		});

		it("pins in 1 month to the single day", () => {
			expect(matched("in 1 month")).toStrictEqual(["11-23"]);
		});

		it("collapses a weekday range to its start", () => {
			expect(matched("fri - mon")).toStrictEqual(["10-23", "10-23@15:00", "10-23@22:00"]);
		});

		it("matches the whole week, starting on the configured day", () => {
			expect([
				matched("this week").filter((label) => !label.includes("@")),
				matched("this week", {weekStartDay: 1}).filter((label) => !label.includes("@")),
			]).toStrictEqual([week(18, 24), week(19, 25)]);
		});

		it("understands French and Japanese casual words", () => {
			expect([matched("demain"), matched("明日")]).toStrictEqual([
				["10-24", "10-24@15:00"],
				["10-24", "10-24@15:00"],
			]);
		});

		it("has no weekend parser", () => {
			expect(matched("weekend")).toStrictEqual([]);
		});

		it("keeps tomorrow as today in the first two hours of the day", () => {
			expect(matched("tomorrow", {now: new Date(2026, 9, 23, 0, 30)})).toStrictEqual([
				"10-23",
				"10-23@15:00",
				"10-23@22:00",
			]);
		});

		it("pins the hour but not the minute for in 2 hours, so a date-only row and a 22:xx row match", () => {
			expect(matched("in 2 hours")).toStrictEqual(["10-23", "10-23@22:00"]);
		});

		it("uses the query's now, not the system clock", () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(2026, 10, 2, 12));
			expect(matched("friday")).toStrictEqual(["10-23", "10-23@15:00", "10-23@22:00"]);
		});
	});
});

describe("search operators meta", () => {
	const ROWS = [...SO_ROWS, searchItem("Done item", "", {completedAt: 1_760_000_000_000})];
	const NAMES = [...SO_PLAIN_NAMES, "Done item"];

	function matchingNames(query: string): string[] {
		const parsed = parseQuery(query);
		return ROWS.flatMap((row, index) => (parsed.matches(row).matches ? [NAMES[index]!] : []));
	}

	const META_MATCH = {matches: true, nameMatches: false, noteMatches: false, metaMatches: true};

	describe("has: operators", () => {
		it("has:note matches non-empty notes as a meta match", () => {
			expect(matchingNames("has:note")).toStrictEqual(["Alpha apple pie"]);
			expect(parseQuery("has:note").matches(ROWS[0]!)).toStrictEqual(META_MATCH);
		});

		it("-has:note matches every row without a note", () => {
			expect(matchingNames("-has:note")).toStrictEqual(NAMES.slice(1));
		});

		it("has:children matches rows with children", () => {
			expect(matchingNames("has:children")).toStrictEqual(["Parent with kids", "Todo list"]);
		});

		it("has:date matches a <time> in the name or note", () => {
			expect(matchingNames("has:date")).toStrictEqual([
				"Meeting Thu, Oct 1, 2026",
				"Past Tue, Sep 15, 2026",
				"Future Fri, Dec 25, 2026",
			]);
		});

		it("is case-insensitive", () => {
			expect(matchingNames("HAS:Note")).toStrictEqual(["Alpha apple pie"]);
		});
	});

	describe("is: operators", () => {
		it("is:todo and is:task match todo and check layouts", () => {
			expect(matchingNames("is:todo")).toStrictEqual(["Todo list"]);
			expect(matchingNames("is:task")).toStrictEqual(["Todo list"]);
			expect(parseQuery("is:todo").matches(searchItem("x", "", {layoutMode: "check"})).matches).toBe(true);
		});

		it("is:complete matches completed items and reveals completed", () => {
			expect(matchingNames("is:complete")).toStrictEqual(["Done item"]);
			expect(parseQuery("is:complete").revealsCompleted()).toBe(true);
			expect(parseQuery("has:note").revealsCompleted()).toBe(false);
		});

		it("-is:complete is false under a completed ancestor", () => {
			const child = searchItem("child", "", {ancestorCompleted: true});
			expect(parseQuery("-is:complete").matches(child).matches).toBe(false);
			expect(parseQuery("-is:complete").matches(ROWS[0]!).matches).toBe(true);
		});

		it("is:incomplete is the local alias of -is:complete", () => {
			expect(matchingNames("is:incomplete")).toStrictEqual(SO_PLAIN_NAMES);
			expect(
				parseQuery("is:incomplete").matches(searchItem("child", "", {ancestorCompleted: true})).matches,
			).toBe(false);
		});

		it("matches layout modes", () => {
			const cases: [string, string][] = [
				["is:divider", "divider"],
				["is:code-block", "code-block"],
				["is:quote", "quote-block"],
				["is:h1", "h1"],
				["text:h2", "h2"],
				["text:h3", "h3"],
				["is:paragraph", "p"],
			];
			for (const [query, layoutMode] of cases) {
				expect(parseQuery(query).matches(searchItem("x", "", {layoutMode})).matches).toBe(true);
				expect(matchingNames(query)).toStrictEqual([]);
			}
		});

		it("is:mirror matches mirrors", () => {
			expect(parseQuery("is:mirror").matches(searchItem("x", "", {isMirror: true})).matches).toBe(true);
			expect(matchingNames("is:mirror")).toStrictEqual([]);
		});
	});

	describe("text: and highlight: operators", () => {
		it("text:bold matches <b> markup", () => {
			expect(matchingNames("text:bold")).toStrictEqual(["Bold word here"]);
		});

		it("matches the other inline formats in the name or note", () => {
			const cases: [string, string][] = [
				["text:italic", "<i>x</i>"],
				["text:underline", "<u>x</u>"],
				["text:strikethrough", "<s>x</s>"],
				["text:code", "<code>x</code>"],
			];
			for (const [query, html] of cases) {
				expect(parseQuery(query).matches(searchItem("plain", html)).matches).toBe(true);
				expect(matchingNames(query)).toStrictEqual([]);
			}
		});

		it("text:<color> and text:colored match coloured spans", () => {
			expect(matchingNames("text:red")).toStrictEqual(["red text line"]);
			expect(matchingNames("text:colored")).toStrictEqual(["red text line"]);
			expect(matchingNames("text:blue")).toStrictEqual([]);
		});

		it("highlight:<color> and text:highlighted match highlights", () => {
			expect(matchingNames("highlight:yellow")).toStrictEqual(["hl text line"]);
			expect(matchingNames("text:highlighted")).toStrictEqual(["hl text line"]);
			expect(matchingNames("text:yellow")).toStrictEqual([]);
		});

		it("bare highlight: matches nothing", () => {
			expect(matchingNames("highlight:")).toStrictEqual([]);
		});
	});

	describe("link:, in:note: and id: operators", () => {
		it("link: matches hrefs by escaped regexp, bare link: matches any link", () => {
			for (const query of ["link:", "link:example", "link:example.com", "link:EXAMPLE"]) {
				expect(matchingNames(query)).toStrictEqual(["Link example"]);
			}
			expect(matchingNames("link:example.org")).toStrictEqual([]);
			expect(matchingNames("link:exampl.")).toStrictEqual([]);
		});

		it('in:note:"words" matches a prefix in the note only, with upstream\'s token grammar', () => {
			expect(matchingNames('in:note:"zebra"')).toStrictEqual(["Alpha apple pie"]);
			expect(parseQuery('in:note:"zebra"').matches(ROWS[0]!)).toStrictEqual({
				matches: true,
				nameMatches: false,
				noteMatches: true,
				metaMatches: false,
			});
			for (const query of ['in:note:"zeb"', 'in:note:"not"', 'in:note:"zebra no"']) {
				expect(matchingNames(query)).toStrictEqual(["Alpha apple pie"]);
			}
			expect(matchingNames("in:note:zeb")).toStrictEqual([]);
			expect(matchingNames("in:note:\u201Czebra\u201D")).toStrictEqual([]);
			expect(matchingNames('in:note:"zebra note"')).toStrictEqual(["Alpha apple pie"]);
			expect(matchingNames('in:note:"apple"')).toStrictEqual([]);
			expect(matchingNames('in:note:"zebra note" apple')).toStrictEqual(["Alpha apple pie"]);
		});

		it("id: matches an id prefix or the 12-hex short id", () => {
			const row = searchItem("x", "", {id: "1c2d3e4f-0000-4000-8000-a1b2c3d4e5f6"});
			expect(parseQuery("id:1c2d").matches(row)).toStrictEqual(META_MATCH);
			expect(parseQuery("id:a1b2c3d4e5f6").matches(row).matches).toBe(true);
			expect(parseQuery("id:A1B2C3D4E5F6").matches(row).matches).toBe(true);
			expect(parseQuery("id:ffff").matches(row).matches).toBe(false);
		});
	});

	describe("is:backlink and in:backlink: operators", () => {
		const backlink = searchItem("Source S", "", {isMirror: true, isBacklink: true});
		const plain = searchItem("Source S");

		it("is:backlink is a meta match on backlink items only", () => {
			expect(parseQuery("is:backlink").matches(backlink)).toStrictEqual({
				matches: true,
				nameMatches: false,
				noteMatches: false,
				metaMatches: true,
			});
			expect(parseQuery("is:backlink").matches(plain).matches).toBe(false);
		});

		it('in:backlink:"Sou" matches a backlink item by name prefix, not a plain item', () => {
			expect(parseQuery('in:backlink:"Sou"').matches(backlink)).toStrictEqual({
				matches: true,
				nameMatches: true,
				noteMatches: false,
				metaMatches: false,
			});
			expect(parseQuery('in:backlink:"Sou"').matches(plain).matches).toBe(false);
		});

		it("an unquoted in:backlink:Source is a plain term", () => {
			expect(parseQuery("in:backlink:Source").matches(backlink).matches).toBe(false);
			expect(parseQuery("in:backlink:Source").matches(searchItem("in:backlink:Source")).matches).toBe(true);
		});
	});

	describe("has:file, has:image, has:video and has:tweet", () => {
		const FILE_ROWS = [
			searchItem("", "", {id: "png", fileType: "image/png"}),
			searchItem("", "", {id: "pdf", fileType: "application/pdf"}),
			searchItem("", "", {id: "mp4", fileType: "video/mp4"}),
			searchItem("plain"),
			searchItem('Watch <a href="https://youtu.be/abc123">clip</a>', "", {id: "youtube"}),
			searchItem('Tweet <a href="https://x.com/alice/status/42">t</a>', "", {id: "tweet"}),
			searchItem("youtube.com/watch?v=nolink", "", {id: "bare-youtube"}),
		];

		function matchingIds(query: string): string[] {
			const parsed = parseQuery(query);
			return FILE_ROWS.flatMap((row) => (parsed.matches(row).matches ? [row.id] : []));
		}

		it("has:file matches an attachment that is not an image", () => {
			expect(matchingIds("has:file")).toStrictEqual(["pdf", "mp4"]);
		});

		it("has:image matches an image attachment", () => {
			expect(matchingIds("has:image")).toStrictEqual(["png"]);
		});

		it("has:video matches a YouTube link in the name, not an attachment", () => {
			expect(matchingIds("has:video")).toStrictEqual(["youtube", "bare-youtube"]);
		});

		it("has:tweet matches a tweet link in the name", () => {
			expect(matchingIds("has:tweet")).toStrictEqual(["tweet"]);
		});

		it("reports a meta match and negates", () => {
			expect([parseQuery("has:image").matches(FILE_ROWS[0]!), matchingIds("-has:file")]).toStrictEqual([
				META_MATCH,
				["png", "plain", "youtube", "tweet", "bare-youtube"],
			]);
		});
	});
});

describe("search operators time", () => {
	const NOW = Date.UTC(2026, 9, 1, 12);
	const HOUR = 3_600_000;
	const MINUTE = 60_000;

	function matches(query: string, overrides: Parameters<typeof searchItem>[2]): boolean {
		return parseQuery(query, {now: NOW}).matches(searchItem("x", "", overrides)).matches;
	}

	describe("sinceTimestamp", () => {
		it("parses h, d and bare minutes, treating other suffixes as minutes and junk as zero", () => {
			expect([
				sinceTimestamp("1h", NOW),
				sinceTimestamp("7d", NOW),
				sinceTimestamp("1w", NOW),
				sinceTimestamp("30", NOW),
				sinceTimestamp("x", NOW),
				sinceTimestamp("-5d", NOW),
			]).toStrictEqual([NOW - 3_600_000, NOW - 604_800_000, NOW - 60_000, NOW - 1_800_000, NOW, NOW]);
		});
	});

	describe("time-range operators", () => {
		it("changed:1d matches an item modified 23h ago but not 25h ago, as a meta match", () => {
			expect(
				parseQuery("changed:1d", {now: NOW}).matches(searchItem("x", "", {modifiedAt: NOW - 23 * HOUR})),
			).toStrictEqual({matches: true, nameMatches: false, noteMatches: false, metaMatches: true});
			expect(matches("changed:1d", {modifiedAt: NOW - 25 * HOUR})).toBe(false);
			expect(matches("changed:1d", {modifiedAt: null})).toBe(false);
		});

		it("last-changed: and last-changed-since: alias changed:, and last-changed:7d keeps working", () => {
			expect([
				matches("last-changed:7d", {modifiedAt: NOW - 6 * 24 * HOUR}),
				matches("last-changed:7d", {modifiedAt: NOW - 8 * 24 * HOUR}),
				matches("last-changed-since:2h", {modifiedAt: NOW - HOUR}),
				matches("last-changed-since:2h", {modifiedAt: NOW - 3 * HOUR}),
			]).toStrictEqual([true, false, true, false]);
		});

		it("last-changed-before: matches items modified before the cutoff", () => {
			expect([
				matches("last-changed-before:1d", {modifiedAt: NOW - 25 * HOUR}),
				matches("last-changed-before:1d", {modifiedAt: NOW - 23 * HOUR}),
			]).toStrictEqual([true, false]);
		});

		it("created:1h matches an item created 59 minutes ago", () => {
			expect([
				matches("created:1h", {createdAt: NOW - 59 * MINUTE}),
				matches("created:1h", {createdAt: NOW - 61 * MINUTE}),
			]).toStrictEqual([true, false]);
		});

		it("completed: and completed-since: match on completedAt", () => {
			expect([
				matches("completed:1d", {completedAt: NOW - HOUR}),
				matches("completed-since:1d", {completedAt: NOW - HOUR}),
				matches("completed:1d", {completedAt: NOW - 25 * HOUR}),
				matches("completed:1d", {completedAt: null}),
			]).toStrictEqual([true, true, false, false]);
		});
	});

	describe("changed-by operators", () => {
		it("changed-by:me and last-changed-by:me match everything; changed-by:others matches nothing", () => {
			expect([
				matches("changed-by:me", {}),
				matches("last-changed-by:me", {}),
				matches("changed-by:others", {}),
				matches("last-changed-by:others", {}),
			]).toStrictEqual([true, true, false, false]);
		});
	});
});

describe("search query ast", () => {
	function matchingNames(query: string): string[] {
		const parsed = parseQuery(query);
		return SO_ROWS.flatMap((row, index) => (parsed.matches(row).matches ? [PLAIN_NAMES[index]!] : []));
	}

	describe("normalizeWithOffsets", () => {
		it("maps ASCII one-to-one and folded accents back to their original span", () => {
			expect(normalizeWithOffsets("Ab<C")).toStrictEqual({
				text: "ab<c",
				starts: [0, 1, 2, 3],
				ends: [1, 2, 3, 4],
			});
			expect(normalizeWithOffsets("Ce\u0301 X")).toStrictEqual({
				text: "ce x",
				starts: [0, 1, 3, 4],
				ends: [1, 3, 4, 5],
			});
		});
	});

	describe("foldPerCharacter", () => {
		it("returns normalizeWithOffsets' text without building the offset arrays", () => {
			const samples = ["Ab<C", "Ce\u0301 X", "Café Ünïcode", "ΟΔΟΣ ΟΔΟΣ", "", "plain ascii text"];
			expect(samples.map(foldPerCharacter)).toStrictEqual([
				"ab<c",
				"ce x",
				"cafe unicode",
				"οδοσ οδοσ",
				"",
				"plain ascii text",
			]);
			expect(samples.map(foldPerCharacter)).toStrictEqual(
				samples.map((sample) => normalizeWithOffsets(sample).text),
			);
		});
	});

	describe("normalizeForSearch", () => {
		it("strips diacritics and lowercases", () => {
			expect(normalizeForSearch("Café Ünïcode")).toBe("cafe unicode");
		});
	});

	describe("parseQuery text matching (upstream SO-root fixture)", () => {
		it("treats the last token as a word-start prefix", () => {
			expect(matchingNames("app")).toStrictEqual(["Alpha apple pie", "applesauce jar"]);
		});

		it("requires non-last tokens to be whole words", () => {
			expect(matchingNames("app pie")).toStrictEqual([]);
		});

		it("ANDs tokens regardless of order", () => {
			expect(matchingNames("apple pie")).toStrictEqual(["Alpha apple pie"]);
			expect(matchingNames("pie apple")).toStrictEqual(["Alpha apple pie"]);
		});

		it("is case-insensitive", () => {
			expect(matchingNames("Apple")).toStrictEqual(["Alpha apple pie", "applesauce jar"]);
		});

		it("matches quoted phrases as literal substrings", () => {
			expect(matchingNames('"ple pie"')).toStrictEqual(["Alpha apple pie"]);
			expect(matchingNames("“ple pie”")).toStrictEqual(["Alpha apple pie"]);
			expect(matchingNames("«ple pie»")).toStrictEqual(["Alpha apple pie"]);
		});

		it("treats an unterminated quote as a plain term containing the quote", () => {
			expect(matchingNames('"apple')).toStrictEqual([]);
		});

		it("negates with a leading dash", () => {
			expect(matchingNames("-apple")).toStrictEqual(PLAIN_NAMES.slice(2));
			expect(matchingNames('-"apple pie"')).toStrictEqual(PLAIN_NAMES.slice(1));
			expect(matchingNames("apple -sauce")).toStrictEqual(["Alpha apple pie"]);
		});

		it("splits AND groups on OR", () => {
			expect(matchingNames("apple OR zebra")).toStrictEqual(["Alpha apple pie"]);
			expect(matchingNames("apple OR kid -todo")).toStrictEqual(["Alpha apple pie", "kid one"]);
		});

		it("matches tags without a leading word boundary", () => {
			for (const query of ["#so", "sotag", '"#sotag "', "#sotag "]) {
				expect(matchingNames(query)).toStrictEqual(["Tagged #soTag item"]);
			}
		});

		it("reports note-only matches", () => {
			expect(parseQuery("zebra").matches(SO_ROWS[0]!)).toStrictEqual({
				matches: true,
				nameMatches: false,
				noteMatches: true,
				metaMatches: false,
			});
		});

		it("folds diacritics both ways", () => {
			expect(parseQuery("café").matches(item("cafe")).matches).toBe(true);
			expect(parseQuery("cafe").matches(item("Café")).matches).toBe(true);
		});

		it("treats a lone dash and an empty phrase as an empty query", () => {
			expect(parseQuery("-").isEmpty()).toBe(true);
			expect(parseQuery('""').isEmpty()).toBe(true);
			expect(parseQuery("apple").isEmpty()).toBe(false);
		});

		it("matches only at word starts", () => {
			const green = item("Green apple pie");
			expect(parseQuery("pple").matches(green).matches).toBe(false);
			expect(parseQuery("ree").matches(green).matches).toBe(false);
			expect(parseQuery("e p").matches(green).matches).toBe(false);
			expect(parseQuery('"apple pie"').matches(green).matches).toBe(true);
		});

		it("does not search HTML markup", () => {
			expect(parseQuery("span").matches(item('<span class="colored c-red">x</span>')).matches).toBe(false);
		});

		it("does not reveal completed items for plain text", () => {
			expect(parseQuery("apple -pie").revealsCompleted()).toBe(false);
		});
	});

	describe("QueryNode.ranges", () => {
		it("returns merged, sorted ranges on plain text", () => {
			expect(parseQuery("apple pie ").ranges("Green apple pie")).toStrictEqual([
				[6, 11],
				[12, 15],
			]);
			expect(parseQuery("#fruitTag").ranges("Plain item #fruitTag")).toStrictEqual([[11, 20]]);
		});

		it("excludes negated terms and merges overlaps", () => {
			expect(parseQuery('"apple p" pie -green').ranges("Green apple pie")).toStrictEqual([[6, 15]]);
		});

		it("maps ranges back through diacritic folding", () => {
			expect(parseQuery("cafe").ranges("Le Café noir")).toStrictEqual([[3, 7]]);
			expect(parseQuery("noir").ranges("Le Café noir")).toStrictEqual([[9, 13]]);
		});
	});

	describe("nested search", () => {
		const chain = (names: string[]): SearchItem[] => {
			const items = names.map((name) => item(name));
			return items.map((row, index) => ({...row, ancestors: items.slice(0, index).toReversed()}));
		};
		const NESTED_ROWS: SearchItem[] = [
			...chain(["Parent with kids", "kid one", "grand kid"]),
			item("Alpha apple pie"),
			item("applesauce jar"),
		];
		const NESTED_ORDER = ["Alpha apple pie", "applesauce jar", "Parent with kids", "kid one", "grand kid"];
		const rows = NESTED_ORDER.map((name) => NESTED_ROWS.find((r) => r.nameHtml === name)!);

		function nestedNames(query: string): string[] {
			const nested = parseNestedQuery(query);
			const parsed = nested ? null : parseQuery(query);
			return rows.flatMap((row) => {
				const result = nested ? matchNested(nested, row) : parsed!.matches(row);
				return result.matches ? [row.nameHtml] : [];
			});
		}

		it("keeps rows whose ancestors match the earlier segments in order", () => {
			expect(nestedNames("parent > kid")).toStrictEqual(["kid one", "grand kid"]);
			expect(nestedNames("parent > grand")).toStrictEqual(["grand kid"]);
			expect(nestedNames("parent > kid > grand")).toStrictEqual(["grand kid"]);
			expect(nestedNames("alpha > pie")).toStrictEqual([]);
			expect(nestedNames("kid > grand OR applesauce")).toStrictEqual(["applesauce jar", "grand kid"]);
			expect(nestedNames("parent > kid -grand")).toStrictEqual(["kid one"]);
		});

		it("is not nested without a standalone > token", () => {
			expect(parseNestedQuery("parent>kid")).toBeNull();
			expect(parseNestedQuery('"parent > kid"')).toBeNull();
			expect(nestedNames("parent>kid")).toStrictEqual([]);
			expect(nestedNames('"parent > kid"')).toStrictEqual([]);
		});

		it("highlights with the last segment only", () => {
			const nested = parseNestedQuery("parent > kid")!;
			expect(nested.highlight.ranges("kid one")).toStrictEqual([[0, 3]]);
			expect(nested.highlight.ranges("Parent with kids")).toStrictEqual([[12, 15]]);
		});
	});
});

describe("search query parser", () => {
	describe("parseSearchQuery", () => {
		it("treats bare terms as required (AND)", () => {
			const parsed = parseSearchQuery("meeting notes");
			expect(parsed.requiredTerms).toStrictEqual(["meeting", "notes"]);
			expect(parsed.orTerms).toStrictEqual([]);
		});

		it("extracts quoted exact phrases", () => {
			const parsed = parseSearchQuery('"quarterly review" agenda');
			expect(parsed.exactPhrases).toStrictEqual(["quarterly review"]);
			// The quoted span is removed before term parsing.
			expect(parsed.requiredTerms).toStrictEqual(["agenda"]);
		});

		it("parses is:complete and is:incomplete", () => {
			expect(parseSearchQuery("done is:complete")).toStrictEqual({
				exactPhrases: [],
				requiredTerms: ["done"],
				orTerms: [],
				excludedTerms: [],
				isComplete: true,
				lastChangedDays: null,
			});
			expect(parseSearchQuery("todo is:incomplete")).toStrictEqual({
				exactPhrases: [],
				requiredTerms: ["todo"],
				orTerms: [],
				excludedTerms: [],
				isComplete: false,
				lastChangedDays: null,
			});
			expect(parseSearchQuery("plain")).toStrictEqual({
				exactPhrases: [],
				requiredTerms: ["plain"],
				orTerms: [],
				excludedTerms: [],
				isComplete: null,
				lastChangedDays: null,
			});
		});

		it("parses last-changed:Nd", () => {
			expect(parseSearchQuery("recent last-changed:7d")).toStrictEqual({
				exactPhrases: [],
				requiredTerms: ["recent"],
				orTerms: [],
				excludedTerms: [],
				isComplete: null,
				lastChangedDays: 7,
			});
			expect(parseSearchQuery("plain")).toStrictEqual({
				exactPhrases: [],
				requiredTerms: ["plain"],
				orTerms: [],
				excludedTerms: [],
				isComplete: null,
				lastChangedDays: null,
			});
		});

		it("collects -negations and removes them from terms", () => {
			const parsed = parseSearchQuery("budget -draft -archived");
			expect(parsed.excludedTerms).toStrictEqual(["draft", "archived"]);
			expect(parsed.requiredTerms).toStrictEqual(["budget"]);
		});

		it("splits OR groups, keeping intra-group terms as AND", () => {
			const parsed = parseSearchQuery("alpha beta OR gamma");
			expect(parsed.orTerms).toStrictEqual([["alpha", "beta"], ["gamma"]]);
			expect(parsed.requiredTerms).toStrictEqual([]);
		});

		it("combines operators in one query", () => {
			const parsed = parseSearchQuery('"exact one" foo -bar is:complete last-changed:3d');
			expect(parsed.exactPhrases).toStrictEqual(["exact one"]);
			expect(parsed.requiredTerms).toStrictEqual(["foo"]);
			expect(parsed.excludedTerms).toStrictEqual(["bar"]);
			expect(parsed.isComplete).toBe(true);
			expect(parsed.lastChangedDays).toBe(3);
		});

		it("returns empty structure for an empty query", () => {
			const parsed = parseSearchQuery("   ");
			expect(parsed).toStrictEqual({
				exactPhrases: [],
				requiredTerms: [],
				orTerms: [],
				excludedTerms: [],
				isComplete: null,
				lastChangedDays: null,
			});
		});
	});
});

describe("search reveal completed", () => {
	describe("QueryNode.revealsCompleted", () => {
		it("propagates through AND, OR and NOT like upstream's shouldRevealMatchingCompletedItems", () => {
			const queries = [
				"is:complete",
				"IS:COMPLETE",
				"rc is:complete",
				"-is:complete",
				"rc OR is:complete",
				"is:complete OR inner",
				"rc",
				"is:completed",
				'"is:complete"',
				"is:incomplete",
			];
			expect(
				Object.fromEntries(queries.map((query) => [query, parseQuery(query).revealsCompleted()])),
			).toStrictEqual({
				"is:complete": true,
				"IS:COMPLETE": true,
				"rc is:complete": true,
				"-is:complete": true,
				"rc OR is:complete": true,
				"is:complete OR inner": true,
				rc: false,
				"is:completed": false,
				'"is:complete"': false,
				"is:incomplete": false,
			});
		});
	});
});

describe("search switcher match", () => {
	describe("splitIntoWords", () => {
		it("normalises and splits on non-word characters, keeping # and @", () => {
			expect(splitIntoWords("  Café, #Tag @Bob!  ")).toStrictEqual(["cafe", "#tag", "@bob"]);
		});

		it("returns no words for an empty query", () => {
			expect(splitIntoWords("  ")).toStrictEqual([]);
		});
	});

	describe("matchField", () => {
		it("scores hits per text length and highlights each hit", () => {
			expect(matchField(["qwzx"], "deep qwzxchild")).toStrictEqual({
				score: 1 / 14,
				html: "deep <b><u>qwzx</u></b>child",
			});
		});

		it("scores 0 with escaped text when any word misses", () => {
			expect(matchField(["deep", "nope"], "deep <x>")).toStrictEqual({
				score: 0,
				html: "deep &lt;x&gt;",
			});
		});

		it("counts every hit of a repeated word", () => {
			expect(matchField(["ab"], "ab ab")).toStrictEqual({
				score: 2 / 5,
				html: "<b><u>ab</u></b> <b><u>ab</u></b>",
			});
		});
	});

	describe("matchSwitcherRow", () => {
		it("matches a word start inside the name", () => {
			expect(matchSwitcherRow({name: "deep qwzxchild", note: "", starLabel: null}, "qwzx")).toStrictEqual({
				labelHtml: "deep <b><u>qwzx</u></b>child",
				searchHtml: null,
			});
		});

		it("does not match mid-word", () => {
			expect(matchSwitcherRow({name: "apple", note: "", starLabel: null}, "pple")).toBeNull();
		});

		it("highlights every word, case-insensitively, on the original text", () => {
			expect(matchSwitcherRow({name: "Qwzx parent page", note: "", starLabel: null}, "par qwz")).toStrictEqual({
				labelHtml: "<b><u>Qwz</u></b>x <b><u>par</u></b>ent page",
				searchHtml: null,
			});
		});

		it("folds diacritics", () => {
			expect(matchSwitcherRow({name: "Café", note: "", starLabel: null}, "cafe")).toStrictEqual({
				labelHtml: "<b><u>Café</u></b>",
				searchHtml: null,
			});
		});

		it("keeps a note-only match with the plain label", () => {
			expect(
				matchSwitcherRow({name: "Unrelated row", note: "qwzx in note only", starLabel: null}, "qwzx"),
			).toStrictEqual({
				labelHtml: "Unrelated row",
				searchHtml: null,
			});
		});

		it("matches a tag with its sigil", () => {
			expect(matchSwitcherRow({name: "#tag", note: "", starLabel: null}, "#tag")).toStrictEqual({
				labelHtml: "<b><u>#tag</u></b>",
				searchHtml: null,
			});
		});

		it("treats # as a word character, like upstream's start-of-word regexp", () => {
			expect(matchSwitcherRow({name: "#tag", note: "", starLabel: null}, "tag")).toBeNull();
		});

		it("returns the plain escaped label for an empty query", () => {
			expect(matchSwitcherRow({name: "a<b", note: "", starLabel: null}, "")).toStrictEqual({
				labelHtml: "a&lt;b",
				searchHtml: null,
			});
		});

		it("matches the plain text of an HTML name", () => {
			expect(matchSwitcherRow({name: "<b>bold</b> name", note: "", starLabel: null}, "bo")).toStrictEqual({
				labelHtml: "<b><u>bo</u></b>ld name",
				searchHtml: null,
			});
		});

		it("matches the raw name markup but labels with the plain text", () => {
			expect(
				matchSwitcherRow(
					{name: '<a href="https://example.com/zzlink">site</a>', note: "", starLabel: null},
					"zzlink",
				),
			).toStrictEqual({
				labelHtml: "site",
				searchHtml: null,
			});
		});

		it("highlights a starred search label", () => {
			expect(matchSwitcherRow({name: "Home", note: "", starLabel: "#todo later"}, "#todo")).toStrictEqual({
				labelHtml: "Home",
				searchHtml: "<b><u>#todo</u></b> later",
			});
		});

		it("requires every word within one field", () => {
			expect(matchSwitcherRow({name: "alpha", note: "beta", starLabel: null}, "alpha beta")).toBeNull();
		});
	});
});

describe("search switcher rank", () => {
	const JOINED_SEC = 1_500_000_000;
	const DAY = 86_400;

	const BASE: StaticScoreInput = {
		depth: 1,
		childCount: 4,
		completed: false,
		lastModifiedSec: null,
		joinedSec: JOINED_SEC,
		nowSec: JOINED_SEC + 1000 * DAY,
		layoutMode: null,
		starred: false,
		name: "plain",
	};

	describe("staticScore", () => {
		it("ranks a depth-1 parent with 4 children above a depth-2 leaf", () => {
			const parent = staticScore(BASE);
			const leaf = staticScore({...BASE, depth: 2, childCount: 0});
			expect({parent, leaf, parentWins: parent > leaf}).toStrictEqual({
				parent: (1 / 1.1) * 1 * 2 * 0.1,
				leaf: (1 / 1.2) * 0.1 * 2 * 0.1,
				parentWins: true,
			});
		});

		it("multiplies by exactly 20 when starred", () => {
			expect(staticScore({...BASE, starred: true}) / staticScore(BASE)).toBe(20);
		});

		it("halves completed nodes", () => {
			expect(staticScore({...BASE, completed: true}) / staticScore(BASE)).toBe(0.5);
		});

		it("doubles h1 and h2 headings but not other layouts", () => {
			const base = staticScore(BASE);
			expect([
				staticScore({...BASE, layoutMode: "h1"}) / base,
				staticScore({...BASE, layoutMode: "h2"}) / base,
				staticScore({...BASE, layoutMode: "h3"}) / base,
				staticScore({...BASE, layoutMode: "board"}) / base,
			]).toStrictEqual([2, 2, 1, 1]);
		});

		it("doubles childCount above 5 and scores leaves at 0.1", () => {
			const base = staticScore(BASE);
			expect([
				staticScore({...BASE, childCount: 5}) / base,
				staticScore({...BASE, childCount: 6}) / base,
				staticScore({...BASE, childCount: 0}) / base,
			]).toStrictEqual([1, 2, 0.1]);
		});

		it("scores recency at 0.1 before the 360-day window and 10 at now", () => {
			const base = staticScore(BASE);
			const nowSec = BASE.nowSec;
			expect(staticScore({...BASE, lastModifiedSec: nowSec - 361 * DAY}) / base).toBe(1);
			expect(staticScore({...BASE, lastModifiedSec: nowSec}) / base).toBeCloseTo(100, 9);
		});

		it("doubles tags and markup in the name only, so a note's tags leave a name hit's score alone", () => {
			const base = staticScore(BASE);
			expect([
				staticScore({...BASE, name: "a #tag"}) / base,
				staticScore({...BASE, name: "a @bob #tag"}) / base,
				staticScore({...BASE, name: "<i>x</i>"}) / base,
				staticScore({...BASE, name: "#a <u>x</u>"}) / base,
			]).toStrictEqual([2, 2, 2, 4]);
		});

		it("matches a fully specified fixture computed by hand", () => {
			const score = staticScore({
				depth: 3,
				childCount: 2,
				completed: false,
				lastModifiedSec: JOINED_SEC + 80_000_000,
				joinedSec: JOINED_SEC,
				nowSec: JOINED_SEC + 86_400_000,
				layoutMode: "h2",
				starred: false,
				name: "Plan #trip <b>now</b>",
			});
			// depth 1/1.3, children 1, open 2, recency 0.1 + 0.099 * (24_704_000 / 311_040), h2 2, name 2*2
			expect(score).toBeCloseTo(98.005698005698, 9);
		});
	});

	describe("staticScore note independence", () => {
		it("gives rows that differ only in their note equal scores", () => {
			expect(staticScore(BASE)).toBe(staticScore({...BASE}));
		});
	});

	describe("textFactor", () => {
		it("scores name hits by query length over name length times 10", () => {
			expect(textFactor("ab", "abcd", "", true, false)).toBe(5);
		});

		it("scores a note-only hit 0, as upstream does, so it ranks after every name hit", () => {
			expect(textFactor("abc", "zz", "abc", false, true)).toBe(0);
		});

		it("multiplies name and note factors when both hit", () => {
			expect(textFactor("ab", "abcd", "abcdefghij", true, true)).toBeCloseTo(0.1, 12);
		});
	});

	describe("resolveJoinedSec", () => {
		it("uses the account join date when available", () => {
			expect(resolveJoinedSec({account: {joinedAt: "2017-07-14T02:40:00.000Z"}, earliestCreatedSec: 1})).toBe(
				1_500_000_000,
			);
		});

		it("falls back to the earliest cached created_at without an account", () => {
			expect(resolveJoinedSec({account: null, earliestCreatedSec: 1})).toBe(1);
		});
	});

	describe("indexText", () => {
		it("measures the folded, entity-decoded text without trimming", () => {
			expect({
				emoji: indexText("\u2714\uFE0F abc").length,
				hangul: indexText("abc \uD55C\uAD6D\uC5B4").length,
				trailing: indexText("abc   ").length,
				ampersand: indexText("abc &amp; b"),
				markup: indexText("<b>Zqrk</b> h\u00E9ading"),
			}).toStrictEqual({emoji: 5, hangul: 12, trailing: 6, ampersand: "abc & b", markup: "zqrk heading"});
		});
	});

	describe("withMonthNames", () => {
		it("appends the months a multi-month time range spans and leaves single-month text alone", () => {
			const range =
				'<time startYear="2026" startMonth="1" startDay="5" endYear="2026" endMonth="3" endDay="2">x</time>';
			expect({
				range: withMonthNames(range),
				single: withMonthNames('<time startYear="2026" startMonth="1" startDay="5">x</time>'),
				year: withMonthNames(range.replace('endYear="2026" endMonth="3"', 'endYear="2027" endMonth="1"'))
					.split(" ")
					.slice(-12),
			}).toStrictEqual({
				range: `${range} Jan Feb Mar`,
				single: '<time startYear="2026" startMonth="1" startDay="5">x</time>',
				year: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
			});
		});
	});
});
