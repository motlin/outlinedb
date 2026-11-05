import {describe, expect, it} from "vite-plus/test";
import {
	matchNested,
	foldPerCharacter,
	normalizeForSearch,
	normalizeWithOffsets,
	parseNestedQuery,
	parseQuery,
} from "../src/search/index.js";
import type {SearchItem} from "../src/search/index.js";
import {SO_PLAIN_NAMES as PLAIN_NAMES, SO_ROWS, searchItem as item} from "./helpers/search-so-fixture.js";

function matchingNames(query: string): string[] {
	const parsed = parseQuery(query);
	return SO_ROWS.flatMap((row, index) => (parsed.matches(row).matches ? [PLAIN_NAMES[index]!] : []));
}

describe("normalizeWithOffsets", () => {
	it("maps ASCII one-to-one and folded accents back to their original span", () => {
		expect(normalizeWithOffsets("Ab<C")).toStrictEqual({text: "ab<c", starts: [0, 1, 2, 3], ends: [1, 2, 3, 4]});
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
		expect(samples.map(foldPerCharacter)).toStrictEqual(samples.map((sample) => normalizeWithOffsets(sample).text));
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
