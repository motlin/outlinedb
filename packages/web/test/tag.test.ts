import {describe, expect, it} from "vite-plus/test";
import
{
	applyAccept,
	attach,
	autocompleteSearch,
	currentQuery,
	narrowResults,
	shouldShow,
	spliceAcceptedTag,
} from "../src/client/tag-autocomplete.js";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {buildTagColorCss, normalizeTagColors} from "../src/client/tag-color-styles.js";
import {cssBlock} from "./helpers/css-block.js";
import {invertOp, tagColorOp} from "../src/client/undo-history.js";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {nodeTreeHost} from "../src/server/node-host.js";
import {bindTreeHost} from "../src/server/tree-snapshot.js";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {join} from "node:path";
import {CacheService, ensureNodeTags} from "@outlinedb/shared/cache";
import * as schema from "@outlinedb/shared/db";
import {nodeContent, nodeMetadata} from "@outlinedb/shared/db";
import {itemTags} from "@outlinedb/shared/tags";
import type {TaggedText} from "@outlinedb/shared/tags";
import {eq, sql} from "drizzle-orm";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {ServerContext} from "../src/server/context.js";
import {mergeFallback, rankCounts} from "../src/server/ops/tag-index.js";
import type {TagCount} from "../src/server/ops/tag-index.js";
import {httpAppFor} from "./http-app-for.js";
import
{
	isTagDeleteClick,
	removeTagAt,
	removeTagFromHtml,
	renderTags,
	renderedTagStarts,
	stripTagMarkup,
	tagCaretUnits,
	teaserPosition,
	toggleTagInQuery,
} from "../src/client/tag-render.js";

describe("tag autocomplete", () =>
{
	describe("attach", () =>
	{
		it("attaches at a bare # after a space", () =>
		{
			expect(attach("Type here #")).toStrictEqual(
				{
					start: 10,
				},
			);
		});

		it("attaches at a bare # glued to a word", () =>
		{
			expect(attach("foo#")).toStrictEqual(
				{
					start: 3,
				},
			);
		});

		it("attaches at the start of a partial tag", () =>
		{
			expect(attach("Type here #taA")).toStrictEqual(
				{
					start: 10,
				},
			);
		});

		it("does not attach after a tag followed by whitespace", () =>
		{
			expect(attach("#taA ")).toBeNull();
		});
	});

	describe("currentQuery", () =>
	{
		it("returns the typed tag between start and caret", () =>
		{
			expect(currentQuery("x #taA", 2, 6)).toBe("#taA");
		});

		it("returns null when the query contains whitespace", () =>
		{
			expect(currentQuery("x #ta A", 2, 7)).toBeNull();
		});

		it("returns a bare # so the popup can open on it", () =>
		{
			expect(currentQuery("foo#", 3, 4)).toBe("#");
		});

		it("accepts colon-separated segments, including a trailing colon", () =>
		{
			expect([currentQuery("#ta:sub:", 0, 8), currentQuery("#ta::", 0, 5)]).toStrictEqual(["#ta:sub:", "#ta::"]);
		});

		it("returns null when the caret is before the start or at it", () =>
		{
			expect([currentQuery("x #taA", 2, 1), currentQuery("x #taA", 2, 2)]).toStrictEqual([null, null]);
		});

		it("returns null when the start is not a # or @", () =>
		{
			expect(currentQuery("x taA", 2, 5)).toBeNull();
		});

		it("returns null for punctuation inside the body", () =>
		{
			expect(currentQuery("#ta.b", 0, 5)).toBeNull();
		});
	});

	describe("shouldShow", () =>
	{
		it("hides a single result equal to the typed text", () =>
		{
			expect(
				shouldShow(
					[
						{
							tag: "#taBold",
						},
					],
					"#taBold",
				),
			).toBe(false);
		});

		it("hides an empty result list", () =>
		{
			expect(shouldShow([], "#taB")).toBe(false);
		});

		it("shows a single result that extends the typed text", () =>
		{
			expect(
				shouldShow(
					[
						{
							tag: "#taBold",
						},
					],
					"#taBol",
				),
			).toBe(true);
		});

		it("shows several results even when one equals the typed text", () =>
		{
			expect(
				shouldShow(
					[
						{
							tag: "#taBold",
						},
						{
							tag: "#taBolder",
						},
					],
					"#taBold",
				),
			).toBe(true);
		});
	});

	describe("applyAccept", () =>
	{
		it("appends a space when the tag is accepted at the end of the text", () =>
		{
			expect(applyAccept("Type here #taA", 10, 14, "#taApple")).toStrictEqual(
				{
					text: "Type here #taApple ",
					caret: 19,
				},
			);
		});

		it("does not add a space when whitespace already follows", () =>
		{
			expect(applyAccept("a #taA b", 2, 6, "#taApple")).toStrictEqual(
				{
					text: "a #taApple b",
					caret: 10,
				},
			);
		});

		it("adds a space when a non-whitespace character follows", () =>
		{
			expect(applyAccept("#taA,x", 0, 4, "#taApple")).toStrictEqual(
				{
					text: "#taApple ,x",
					caret: 9,
				},
			);
		});

		it("does not add a space after a tag ending in a colon", () =>
		{
			expect(applyAccept("#ta", 0, 3, "#ta:sub:")).toStrictEqual(
				{
					text: "#ta:sub:",
					caret: 8,
				},
			);
		});

		it("replaces only the case-insensitively matching prefix", () =>
		{
			expect(applyAccept("#TAAx", 0, 5, "#taApple")).toStrictEqual(
				{
					text: "#taApple x",
					caret: 9,
				},
			);
		});
	});

	describe("spliceAcceptedTag", () =>
	{
		it("replaces plain-text units inside rich text, escaping the inserted tag", () =>
		{
			expect(
				spliceAcceptedTag(
					"<b>x</b> #ta y",
					{
						start: 2,
						end: 5,
						inserted: "#a&b ",
					},
				),
			).toBe("<b>x</b> #a&amp;b  y");
		});
	});

	describe("autocompleteSearch", () =>
	{
		it("sends the edited field's live text so the server counts it in place of the saved text", () =>
		{
			expect([
				autocompleteSearch(
					{
						root: "z",
						prefix: "#me",
						item: "n1",
						field: "name",
						text: "Plan #me",
					},
				),
				autocompleteSearch(
					{
						root: "",
						prefix: "#",
						item: "n2",
						field: "note",
						text: "x #",
					},
				),
			]).toStrictEqual([
				"root=z&prefix=%23me&limit=8&fallback=1&item=n1&name=Plan+%23me",
				"root=&prefix=%23&limit=8&fallback=1&item=n2&note=x+%23",
			]);
		});
	});

	describe("narrowResults", () =>
	{
		it("keeps results that still start with the query, ignoring case", () =>
		{
			expect([
				narrowResults(
					[
						{
							tag: "#taZebra",
						},
						{
							tag: "#taApple",
						},
					],
					"#taZ",
				),
				narrowResults(
					[
						{
							tag: "#taZebra",
						},
					],
					"#TAZ",
				),
			]).toStrictEqual([
				[
					{
						tag: "#taZebra",
					},
				],
				[
					{
						tag: "#taZebra",
					},
				],
			]);
		});
	});
});

describe("tag color styles", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
	const COLORS = ["red", "orange", "yellow", "green", "teal", "sky", "blue", "purple", "pink", "gray"];

	describe("buildTagColorCss", () =>
	{
		it("emits one block per color in index order, then five shared blocks over all tags", () =>
		{
			const css = buildTagColorCss(
				{
					"#b": "green",
					"#a": "red",
					"#c": "green",
				},
			);
			const blocks = css.split("}\n").filter((block) => block !== "");
			const first = (block: string) => block.slice(0, block.indexOf(" {"));
			const sel = (suffix: string, prefix = "") =>
				["#b", "#a", "#c"].map((tag) => `${prefix}.contentTag[data-val="${tag}"]${suffix}`).join(",");
			expect(blocks).toHaveLength(7);
			expect(blocks.map((block) => first(block))).toStrictEqual([
				'.contentTag[data-val="#a"]',
				'.contentTag[data-val="#b"],.contentTag[data-val="#c"]',
				sel(" span"),
				sel(":hover"),
				sel(".contentTag .contentTagText"),
				sel("", ".notes "),
				sel("", ".done "),
			]);
			expect(blocks[0]).toContain("background-color: var(--wf-background-red)!important");
			expect(blocks[1]).toContain("background-color: var(--wf-background-green)!important");
		});

		it("never emits the invented --wf-tag-bg- family", () =>
		{
			expect(
				buildTagColorCss(
					{
						"#x": "red",
					},
				),
			).not.toContain("--wf-tag-bg-");
		});

		it.each(COLORS)("paints .bc-%s from the upstream --wf-background token", (color) =>
		{
			expect(cssBlock(styles, `.bc-${color}.bc-${color}`)["background-color"]).toBe(
				`var(--wf-background-${color})`,
			);
		});

		it.each(COLORS)("colors .c-%s text from the upstream --wf-text token", (color) =>
		{
			expect(cssBlock(styles, `.c-${color}`).color).toBe(`var(--wf-text-${color})`);
		});

		it("is empty without colors", () =>
		{
			expect(buildTagColorCss({})).toBe("");
		});

		it("escapes quotes and backslashes in the attribute value", () =>
		{
			expect(
				buildTagColorCss(
					{
						'#a"b\\c': "red",
					},
				).split("\n")[0],
			).toBe(String.raw`.contentTag[data-val="#a\"b\\c"] {`);
		});
	});

	describe("normalizeTagColors", () =>
	{
		it("lowercases keys", () =>
		{
			expect(
				normalizeTagColors(
					{
						"#TaZebra": "green",
						"@Alice": "red",
					},
				),
			).toStrictEqual(
				{
					"#tazebra": "green",
					"@alice": "red",
				},
			);
		});
	});
});

describe("tag color undo", () =>
{
	describe("tagColorOp", () =>
	{
		it("records setting a color over none, and its inverse removes it", () =>
		{
			const op = tagColorOp("#x", undefined, "green");
			expect([op, op && invertOp(op)]).toStrictEqual([
				{
					kind: "tagColor",
					tag: "#x",
					before: null,
					after: "green",
				},
				{
					kind: "tagColor",
					tag: "#x",
					before: "green",
					after: null,
				},
			]);
		});

		it("records the previous color when removing, and nothing when the color is unchanged", () =>
		{
			expect([
				tagColorOp("#x", "red", null),
				tagColorOp("#x", "red", "red"),
				tagColorOp("#x", undefined, null),
			]).toStrictEqual([
				{
					kind: "tagColor",
					tag: "#x",
					before: "red",
					after: null,
				},
				null,
				null,
			]);
		});
	});
});

describe("tag css", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

	describe("tag CSS parity with upstream wf-base", () =>
	{
		it("styles .content .contentTag like upstream", () =>
		{
			expect(cssBlock(styles, ".content .contentTag")).toStrictEqual(
				{
					color: "var(--wf-text-tertiary)",
					"word-break": "normal",
					padding: "0 1px",
					margin: "0 -1px",
					"border-radius": "3px",
					cursor: "pointer",
				},
			);
		});

		it("neutralizes inline formatting inside a tag", () =>
		{
			expect(cssBlock(styles, ".content .contentTag b")).toStrictEqual(
				{
					"font-weight": "inherit",
				},
			);
			expect(cssBlock(styles, ".content .contentTag i")).toStrictEqual(
				{
					"font-style": "inherit",
				},
			);
			expect(cssBlock(styles, ".content .contentTag u")).toStrictEqual(
				{
					"text-decoration": "none",
				},
			);
		});

		it("highlights a hovered tag with the tertiary background", () =>
		{
			expect(cssBlock(styles, ".content .contentTag:hover")).toStrictEqual(
				{
					background: "var(--wf-background-tertiary)",
				},
			);
		});

		it("underlines only the tag text, not the #", () =>
		{
			expect(cssBlock(styles, ".content .contentTag .contentTagText")).toStrictEqual(
				{
					"text-decoration": "underline",
				},
			);
			expect(cssBlock(styles, ".content .contentTag")["text-decoration"]).toBeUndefined();
		});

		it("carries the delete-hover, selection and tapped states", () =>
		{
			expect(cssBlock(styles, ".content .contentTag.contentTagDelete:hover")).toStrictEqual(
				{
					"background-color": "#f4666633",
				},
			);
			expect(cssBlock(styles, ".content .contentTag.contentTagDeleteHover:hover")).toStrictEqual(
				{
					color: "#f4666666",
				},
			);
			expect(cssBlock(styles, ".content .contentTag.contentTagDeleteHover:hover .contentTagNub")).toStrictEqual(
				{
					display: "none",
				},
			);
			expect(cssBlock(styles, ".project.addedToSelection .content .contentTag:hover")).toStrictEqual(
				{
					background: "none",
				},
			);
			expect(cssBlock(styles, ".contentTag.tapped")).toStrictEqual(
				{
					background: "var(--wf-background-tertiary)",
				},
			);
		});

		it("has no legacy .tag-link or .innerContentContainer .contentTag selectors", () =>
		{
			expect(styles.includes(".tag-link")).toBe(false);
			expect(styles.includes(".innerContentContainer .contentTag")).toBe(false);
		});
	});

	describe("tag color teaser glyph", () =>
	{
		it("is a 15px circle (default content-box 13px plus border) in the inherited color", () =>
		{
			const glyph = cssBlock(styles, ".tag-color-teaser-glyph");
			expect(glyph["box-sizing"]).toBeUndefined();
			expect(glyph.color).toBe("inherit");
			expect(JSON.stringify(glyph)).not.toContain("--wf-text-link");
		});
	});

	describe("mention CSS parity with upstream wf-base", () =>
	{
		it("shows the @ sign after the at-sign span", () =>
		{
			expect(cssBlock(styles, ".mention .at-sign::after")).toStrictEqual(
				{
					content: '"@"',
				},
			);
		});

		it("sizes the @ sign in notes", () =>
		{
			expect(cssBlock(styles, ".notes .mention .at-sign")).toStrictEqual(
				{
					"font-size": "12px",
				},
			);
			expect(cssBlock(styles, ".root > .notes .mention .at-sign")).toStrictEqual(
				{
					"font-size": "inherit",
				},
			);
		});
	});
});

describe("tag index", () =>
{
	/**
	 * The tag counts the server computed in JS before node_tags: every item's distinct tags, counted once per item in
	 * the order given, keeping each tag's first-seen casing. The reference the SQL autocomplete must match.
	 */
	function jsCounts(rows: Iterable<TaggedText>): Map<string, TagCount>
	{
		const counts = new Map<string, TagCount>();
		for (const row of rows)
		{
			for (const [lower, tag] of itemTags(row))
			{
				const entry = counts.get(lower);
				counts.set(
					lower,
					entry
						?
							{
								tag: entry.tag,
								count: entry.count + 1,
							}
						:
							{
								tag,
								count: 1,
							},
				);
			}
		}
		return counts;
	}

	function rankTags(
		rows: Iterable<TaggedText>,
		options:
		{
			prefix: string;
			limit: number;
		},
	): TagCount[]
	{
		return rankCounts(jsCounts(rows), options);
	}

	const FIXTURE_NAMES = [
		"Alpha #taZebra item",
		"Beta #taZebra #taApple",
		"Gamma #taApple @taPerson",
		"Delta #TaZebra upper, #ta:sub:key end",
		"Numbers #123 #1234 #12a",
		"Edge (#taParen) #taDot. foo#taNo",
		"Bold <b>#taBold</b> tag",
		"Type here",
	];

	const FIXTURE_ROWS = FIXTURE_NAMES.map((name) => (
	{
		name,
		note: null,
	}));

	function asPairs(tags: TagCount[]): string[]
	{
		return tags.map(({tag, count}) => `${tag}:${count}`);
	}

	describe("rankTags in code blocks", () =>
	{
		it("leaves a code block's tags out of the counts", () =>
		{
			expect(
				asPairs(
					rankTags(
						[
							{
								name: "#a",
								note: null,
								layoutMode: "code-block",
							},
							{
								name: "#b",
								note: null,
							},
						],
						{
							prefix: "#",
							limit: 8,
						},
					),
				),
			).toStrictEqual(["#b:1"]);
		});
	});

	describe("rankTags", () =>
	{
		it("ranks every tag by count, then non-digit before digit, then plain string order, capped at the limit", () =>
		{
			expect(
				asPairs(
					rankTags(
						FIXTURE_ROWS,
						{
							prefix: "#",
							limit: 8,
						},
					),
				),
			).toStrictEqual([
				"#taZebra:3",
				"#taApple:2",
				"#ta:sub:key:1",
				"#taBold:1",
				"#taDot:1",
				"#taParen:1",
				"#1234:1",
				"#12a:1",
			]);
		});

		it("matches the prefix case-insensitively", () =>
		{
			expect(
				asPairs(
					rankTags(
						FIXTURE_ROWS,
						{
							prefix: "#taA",
							limit: 8,
						},
					),
				),
			).toStrictEqual(["#taApple:2"]);
			expect(
				asPairs(
					rankTags(
						FIXTURE_ROWS,
						{
							prefix: "#TA",
							limit: 8,
						},
					),
				),
			).toStrictEqual(["#taZebra:3", "#taApple:2", "#ta:sub:key:1", "#taBold:1", "#taDot:1", "#taParen:1"]);
		});

		it("counts tags in notes and skips #use-template tags", () =>
		{
			const rows = [
				{
					name: "One",
					note: "#taNote and #use-template:x",
				},
				{
					name: "Two #taNote",
					note: null,
				},
			];

			expect(
				rankTags(
					rows,
					{
						prefix: "#",
						limit: 8,
					},
				),
			).toStrictEqual([
				{
					tag: "#taNote",
					count: 2,
				},
			]);
		});
	});

	describe("mergeFallback", () =>
	{
		it("fills from the fallback list with tags not already listed", () =>
		{
			expect(
				mergeFallback(
					[
						{
							tag: "#a",
							count: 2,
						},
					],
					[
						{
							tag: "#a",
							count: 5,
						},
						{
							tag: "#b",
							count: 1,
						},
					],
					8,
				),
			).toStrictEqual([
				{
					tag: "#a",
					count: 2,
				},
				{
					tag: "#b",
					count: 1,
				},
			]);
		});

		it("stops at the limit", () =>
		{
			expect(
				mergeFallback(
					[
						{
							tag: "#a",
							count: 2,
						},
					],
					[
						{
							tag: "#b",
							count: 5,
						},
						{
							tag: "#c",
							count: 1,
						},
					],
					2,
				),
			).toStrictEqual([
				{
					tag: "#a",
					count: 2,
				},
				{
					tag: "#b",
					count: 5,
				},
			]);
		});
	});

	/*
	 * root ("TA root #taRoot")
	 *   one per FIXTURE_NAMES entry
	 * outside ("Outside #taOutside #taZebra")
	 * deleted ("Deleted #taGone", no longer live)
	 */
	function setupDb()
	{
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(
			sqlite,
			{
				schema,
			},
		);
		bindTreeHost(db, nodeTreeHost(sqlite));
		migrate(
			db,
			{
				migrationsFolder: join(import.meta.dirname, "../../shared/src/db/migrations"),
			},
		);
		const seededAt = "2026-01-01 00:00:00.000";
		const rows:
		{
			id: string;
			parentId: string | null;
			name: string;
			systemTo?: string;
		}[] = [
			{
				id: "root",
				parentId: null,
				name: "TA root #taRoot",
			},
			...FIXTURE_NAMES.map((name, index) => (
			{
				id: `child-${index}`,
				parentId: "root",
				name,
			})),
			{
				id: "outside",
				parentId: null,
				name: "Outside #taOutside #taZebra",
			},
			{
				id: "deleted",
				parentId: "root",
				name: "Deleted #taGone",
				systemTo: "2026-02-01 00:00:00.000",
			},
		];
		for (const {id, parentId, name, systemTo = FAR_FUTURE_DATE} of rows)
		{
			db.insert(nodeContent)
				.values(
					{
						id,
						name,
						note: null,
						parentId,
						systemFrom: seededAt,
						systemTo,
					},
				)
				.run();
		}
		ensureNodeTags(db);
		return db;
	}

	function setup(db = setupDb())
	{
		const ctx =
		{
			db,
			cacheService: new CacheService(db),
		} as unknown as ServerContext;
		return httpAppFor(ctx);
	}

	async function getTags(app: ReturnType<typeof httpAppFor>, query: string): Promise<string[]>
	{
		const response = await app.fetch(new Request(`http://x/api/v1/tags/autocomplete?${query}`));
		if (response.status !== 200)
		{
			throw new Error(await response.text());
		}
		const body = (await response.json()) as
		{
			tags: TagCount[];
		};
		return asPairs(body.tags);
	}

	describe("GET /api/v1/tags/autocomplete", () =>
	{
		it("ranks the zoomed subtree including the root's own text, without fallback", async () =>
		{
			await expect(getTags(setup(), "root=root&prefix=%23&limit=8&fallback=0")).resolves.toStrictEqual([
				"#taZebra:3",
				"#taApple:2",
				"#ta:sub:key:1",
				"#taBold:1",
				"#taDot:1",
				"#taParen:1",
				"#taRoot:1",
				"#1234:1",
			]);
		});

		it("fills from the whole tree when the subtree has fewer than the limit", async () =>
		{
			await expect(getTags(setup(), "root=root&prefix=%23taZ&limit=8")).resolves.toStrictEqual(["#taZebra:3"]);
			await expect(getTags(setup(), "root=child-0&prefix=%23ta&limit=3")).resolves.toStrictEqual([
				"#taZebra:1",
				"#taApple:2",
				"#ta:sub:key:1",
			]);
		});

		it("ranks the whole live tree at Home", async () =>
		{
			await expect(getTags(setup(), "prefix=%23taO")).resolves.toStrictEqual(["#taOutside:1"]);
			await expect(getTags(setup(), "prefix=%23taZ")).resolves.toStrictEqual(["#taZebra:4"]);
			await expect(getTags(setup(), "prefix=%23taG")).resolves.toStrictEqual([]);
		});
	});

	describe("GET /api/v1/tags/autocomplete and code blocks", () =>
	{
		it("counts no tag from a code-block row, in the subtree or the whole tree", async () =>
		{
			const db = setupDb();
			const at = "2026-01-02 00:00:00.000";
			db.insert(nodeContent)
				.values(
					{
						id: "code",
						name: "#taCodeOnly #taZebra",
						note: null,
						parentId: "root",
						systemFrom: at,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			db.insert(nodeMetadata)
				.values(
					{
						nodeId: "code",
						layoutMode: "code-block",
						systemFrom: at,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			db.run(sql`DELETE FROM node_tags`);
			ensureNodeTags(db);
			expect([
				await getTags(setup(db), "prefix=%23taC"),
				await getTags(setup(db), "root=root&prefix=%23taC&fallback=0"),
				await getTags(setup(db), "prefix=%23taZ"),
			]).toStrictEqual([[], [], ["#taZebra:4"]]);
		});
	});

	describe("GET /api/v1/tags/autocomplete with the edited item's live text", () =>
	{
		it("counts the edited item's live name instead of its saved one, as upstream's per-keystroke tag counts do", async () =>
		{
			const live = new URLSearchParams(
				{
					root: "root",
					prefix: "#taZ",
					fallback: "0",
					item: "child-0",
					name: "Alpha #taZoo",
				},
			);
			await expect(getTags(setup(), live.toString())).resolves.toStrictEqual(["#taZebra:2", "#taZoo:1"]);
		});

		it("counts the edited item's live note alongside its saved name", async () =>
		{
			const live = new URLSearchParams(
				{
					prefix: "#taZ",
					item: "child-0",
					note: "#taZoo",
				},
			);
			await expect(getTags(setup(), live.toString())).resolves.toStrictEqual(["#taZebra:4", "#taZoo:1"]);
		});

		it("swaps a saved tag for the in-progress one the live name has instead", async () =>
		{
			const live = new URLSearchParams(
				{
					prefix: "#taA",
					item: "child-1",
					name: "Beta #taZebra #taA",
				},
			);
			await expect(getTags(setup(), live.toString())).resolves.toStrictEqual(["#taA:1", "#taApple:1"]);
		});
	});

	describe("GET /api/v1/tags/autocomplete over node_tags", () =>
	{
		/** Live rows in rowid order with their layout mode, the order the JS whole-tree count read them in. */
		function liveRows(db: ReturnType<typeof setupDb>, ids?: Set<string>): TaggedText[]
		{
			return db
				.select(
					{
						id: nodeContent.id,
						name: nodeContent.name,
						note: nodeContent.note,
						layoutMode: nodeMetadata.layoutMode,
					},
				)
				.from(nodeContent)
				.leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodeContent.id))
				.where(eq(nodeContent.systemTo, FAR_FUTURE_DATE))
				.orderBy(sql`${nodeContent}.rowid`)
				.all()
				.filter((row) => ids === undefined || ids.has(row.id));
		}

		it("matches the JS counts at Home and zoomed, with code-block and #use-template tags", async () =>
		{
			const db = setupDb();
			const at = "2026-01-02 00:00:00.000";
			const extra = [
				{
					id: "code",
					name: "#taCode #taZebra",
					parentId: "root",
				},
				{
					id: "template",
					name: "Uses #use-template:daily #taApple",
					parentId: "root",
				},
				{
					id: "casing",
					name: "#TAAPPLE again",
					parentId: "outside",
				},
			];
			for (const {id, name, parentId} of extra)
			{
				db.insert(nodeContent)
					.values(
						{
							id,
							name,
							note: null,
							parentId,
							systemFrom: at,
							systemTo: FAR_FUTURE_DATE,
						},
					)
					.run();
			}
			db.insert(nodeMetadata)
				.values(
					{
						nodeId: "code",
						layoutMode: "code-block",
						systemFrom: at,
						systemTo: FAR_FUTURE_DATE,
					},
				)
				.run();
			db.run(sql`DELETE FROM node_tags`);
			ensureNodeTags(db);
			const app = setup(db);
			const all =
			{
				prefix: "#",
				limit: 100,
			};
			const subtree = new Set(["root", "code", "template", ...FIXTURE_NAMES.map((_, index) => `child-${index}`)]);
			const pairs = (rows: TaggedText[]) => asPairs(rankTags(rows, all));

			expect(
				{
					home: await getTags(app, "prefix=%23&limit=100"),
					zoomed: await getTags(app, "root=root&prefix=%23&limit=100&fallback=0"),
				},
			).toStrictEqual(
				{
					home: pairs(liveRows(db)),
					zoomed: pairs(liveRows(db, subtree)),
				},
			);
		});

		it("drops a tag from node_tags and the counts when an edit removes it", async () =>
		{
			const db = setupDb();
			const cache = new CacheService(db);
			const app = setup(db);
			const before = await getTags(app, "prefix=%23taO");

			cache.insertNode(
				{
					id: "outside",
					name: "Outside #taZebra",
					note: null,
					parent_id: null,
					priority: 1,
					createdAt: 1,
					modifiedAt: 1,
				},
				null,
			);

			expect(
				{
					before,
					after: await getTags(app, "prefix=%23taO"),
					rows: db.all(sql`SELECT tag FROM node_tags WHERE node_id = 'outside' ORDER BY tag`),
				},
			).toStrictEqual(
				{
					before: ["#taOutside:1"],
					after: [],
					rows: [
						{
							tag: "#taZebra",
						},
					],
				},
			);
		});
	});
});

describe("tag render", () =>
{
	function tagSpan(tag: string): string
	{
		return `<span class="contentTag explosive" title="Filter ${tag}" data-val="${tag.toLowerCase()}">${tag.slice(0, 1)}<span class="contentTagText">${tag.slice(1)}</span><span class="contentTagNub"></span></span>`;
	}

	describe("renderTags", () =>
	{
		it("wraps a tag in the upstream contentTag markup", () =>
		{
			expect(renderTags("Alpha #taZebra item")).toBe(
				'Alpha <span class="contentTag explosive" title="Filter #taZebra" data-val="#tazebra">#<span class="contentTagText">taZebra</span><span class="contentTagNub"></span></span> item',
			);
		});

		it("never tags text inside links, attributes, or after an entity", () =>
		{
			const html = 'Link <a href="https://example.com/#taFrag">site #taLinked</a> and &amp;#taAmp';
			expect(renderTags(html)).toBe(html);
		});

		it("never tags text inside code", () =>
		{
			const html = "Run <code>#taCode</code> now";
			expect(renderTags(html)).toBe(html);
		});

		it("keeps formatting that wraps the whole tag outside the span", () =>
		{
			expect(renderTags("Bold <b>#taBold</b> tag")).toBe(
				'Bold <b><span class="contentTag explosive" title="Filter #taBold" data-val="#tabold">#<span class="contentTagText">taBold</span><span class="contentTagNub"></span></span></b> tag',
			);
		});

		it("skips short numeric tags", () =>
		{
			expect(renderTags("Numbers #123 #1234")).toBe(`Numbers #123 ${tagSpan("#1234")}`);
		});

		it("wraps a colon-joined tag as one span", () =>
		{
			expect(renderTags("Delta #ta:sub:key end")).toBe(`Delta ${tagSpan("#ta:sub:key")} end`);
		});

		it("wraps mentions the same way", () =>
		{
			expect(renderTags("Ping @Alice now")).toBe(`Ping ${tagSpan("@Alice")} now`);
		});

		it("re-encodes the tag text exactly as it appeared and escapes attributes", () =>
		{
			expect(renderTags("Amp #ta&amp;b end")).toBe(
				'Amp <span class="contentTag explosive" title="Filter #ta&amp;b" data-val="#ta&amp;b">#<span class="contentTagText">ta&amp;b</span><span class="contentTagNub"></span></span> end',
			);
		});

		it("leaves a tag split across formatting untouched", () =>
		{
			const html = "Split #ta<b>Half</b> end";
			expect(renderTags(html)).toBe(html);
		});

		it("treats &nbsp; as a boundary", () =>
		{
			expect(renderTags("Space&nbsp;#taNbsp end")).toBe(`Space&nbsp;${tagSpan("#taNbsp")} end`);
		});
	});

	describe("teaserPosition", () =>
	{
		it("places the teaser at the tag's right edge, vertically centred plus the Flyout margin", () =>
		{
			expect(
				teaserPosition(
					{
						top: 146.5,
						right: 216.92,
						height: 19,
					},
				),
			).toStrictEqual(
				{
					left: 215.92,
					top: 146.5,
				},
			);
		});
	});

	describe("toggleTagInQuery", () =>
	{
		it("appends a new tag and removes one already in the query, case-insensitively, keeping one trailing space", () =>
		{
			expect(
				{
					empty: toggleTagInQuery("", "#taZebra"),
					append: toggleTagInQuery("#taZebra ", "#taApple"),
					removeCaseInsensitive: toggleTagInQuery("#taZebra #taApple ", "#TAAPPLE"),
					removeLast: toggleTagInQuery("#taZebra ", "#taZebra"),
					prefixIsNotMatch: toggleTagInQuery("#taZebraLong ", "#taZebra"),
					regexChars: toggleTagInQuery("#a.b ", "#a+b"),
				},
			).toStrictEqual(
				{
					empty: "#taZebra ",
					append: "#taZebra #taApple ",
					removeCaseInsensitive: "#taZebra ",
					removeLast: "",
					prefixIsNotMatch: "#taZebraLong #taZebra ",
					regexChars: "#a.b #a+b ",
				},
			);
		});
	});

	describe("removeTagAt", () =>
	{
		it("removes the tag plus following spaces and tabs, leaving the caret at the tag's start", () =>
		{
			expect(
				{
					trailing: removeTagAt("Type here #taApple #taZebra foo #taBold ", 32, "#taBold"),
					tab: removeTagAt("a #x\tb", 2, "#x"),
					mismatch: removeTagAt("a #x b", 2, "#y"),
				},
			).toStrictEqual(
				{
					trailing:
					{
						text: "Type here #taApple #taZebra foo ",
						caret: 32,
					},
					tab:
					{
						text: "a b",
						caret: 2,
					},
					mismatch:
					{
						text: "a #x b",
						caret: 2,
					},
				},
			);
		});
	});

	describe("removeTagFromHtml", () =>
	{
		it("removes the tag through the plain-text map and leaves surrounding markup intact", () =>
		{
			expect(
				{
					afterBold: removeTagFromHtml("<b>x</b> #t y", 2, "#t"),
					entities: removeTagFromHtml("a &amp; #t &lt;b", 4, "#t"),
					spaceInNextSegment: removeTagFromHtml("#t<i> y</i>", 0, "#t"),
					mismatch: removeTagFromHtml("<b>x</b> #t y", 2, "#u"),
				},
			).toStrictEqual(
				{
					afterBold: "<b>x</b> y",
					entities: "a &amp; &lt;b",
					spaceInNextSegment: "<i>y</i>",
					mismatch: "<b>x</b> #t y",
				},
			);
		});
	});

	describe("renderedTagStarts", () =>
	{
		it("lists the plain offsets of the tags renderTags wraps, skipping links and code", () =>
		{
			expect(renderedTagStarts('#a <a href="x">#b</a> <code>#c</code> @d')).toStrictEqual([0, 9]);
		});
	});

	describe("tagCaretUnits", () =>
	{
		it("counts a date pill as one caret unit and entities as one, unlike the label-length tag offsets", () =>
		{
			const pill = '<time startYear="2026" startMonth="10" startDay="19">Oct 19, 2026</time>';
			expect(
				{
					afterPill: tagCaretUnits(`${pill} #a #b text`, 16),
					entities: tagCaretUnits("a &amp; #t", 4),
					plain: tagCaretUnits("#a #b", 3),
				},
			).toStrictEqual(
				{
					afterPill: 5,
					entities: 4,
					plain: 3,
				},
			);
		});
	});

	describe("isTagDeleteClick", () =>
	{
		it("is Meta-click on mac and Meta- or Alt-click elsewhere", () =>
		{
			expect(
				{
					macMeta: isTagDeleteClick(
						{
							metaKey: true,
							altKey: false,
						},
						true,
					),
					macAlt: isTagDeleteClick(
						{
							metaKey: false,
							altKey: true,
						},
						true,
					),
					otherAlt: isTagDeleteClick(
						{
							metaKey: false,
							altKey: true,
						},
						false,
					),
					otherMeta: isTagDeleteClick(
						{
							metaKey: true,
							altKey: false,
						},
						false,
					),
					plain: isTagDeleteClick(
						{
							metaKey: false,
							altKey: false,
						},
						false,
					),
				},
			).toStrictEqual(
				{
					macMeta: true,
					macAlt: false,
					otherAlt: true,
					otherMeta: true,
					plain: false,
				},
			);
		});
	});

	describe("stripTagMarkup", () =>
	{
		it("unwraps rendered tags back to stored html, keeping other spans", () =>
		{
			const html = 'Hi <b><span class="colored c-red">x</span> #taBold</b> @Ellen&nbsp;';
			expect(stripTagMarkup(renderTags(html))).toBe(html);
		});

		it("unwraps a tag span the browser left holding extra typed text", () =>
		{
			expect(stripTagMarkup(`${tagSpan("#taZeb").replace("Zeb<", "Zebra<")} end`)).toBe("#taZebra end");
		});
	});
});
