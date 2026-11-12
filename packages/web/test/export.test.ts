import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it, vi} from "vite-plus/test";
import {cssBlock, hasSelector} from "./helpers/css-block.js";
import {filterBySearch, openMenuExport, selectionExportRequest} from "../src/client/export-entry.js";
import type {ExportRequest} from "../src/client/export-entry.js";
import DatabaseConstructor from "better-sqlite3";
import {drizzle} from "drizzle-orm/better-sqlite3";
import {migrate} from "drizzle-orm/better-sqlite3/migrator";
import {Hono} from "hono";
import {join} from "node:path";
import * as schema from "@outlinedb/shared/db";
import type {WorkflowyNode} from "@outlinedb/shared/types";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {CacheService, storeInternalMetadata} from "@outlinedb/shared/cache";

describe("export dialog css", () => {
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

	describe("export dialog button styles", () => {
		it("gives .wf-dialog buttons upstream's bare button base, .primary and .large at zero specificity", () => {
			expect({
				base: cssBlock(styles, ":where(.wf-dialog) button"),
				hover: cssBlock(
					styles,
					":where(.wf-dialog) button:focus, :where(.wf-dialog) button:hover, :where(.wf-dialog) button:active",
				),
				primary: cssBlock(styles, ":where(.wf-dialog) .primary"),
				primaryHover: cssBlock(
					styles,
					":where(.wf-dialog) .primary:focus, :where(.wf-dialog) .primary:hover, :where(.wf-dialog) .primary:active",
				),
				large: cssBlock(styles, ":where(.wf-dialog) .large"),
			}).toStrictEqual({
				base: {
					display: "inline-block",
					position: "relative",
					"-webkit-appearance": "none",
					appearance: "none",
					border: "none",
					outline: "none",
					"box-sizing": "border-box",
					"border-radius": "var(--wf-radius-pill)",
					padding: "var(--wf-space-s) var(--wf-space-l)",
					"font-weight": "var(--wf-font-weight-regular)",
					"line-height": "var(--wf-line-height-s)",
					"font-family": "inherit",
					"font-size": "var(--wf-font-size-s)",
					background: "var(--wf-background-tertiary)",
					"text-align": "center",
					"text-decoration": "none",
					color: "var(--wf-text-primary)",
					cursor: "pointer",
					"-webkit-tap-highlight-color": "transparent",
				},
				hover: {
					"text-decoration": "none",
					"background-color": "color-mix(in srgb, var(--wf-background-quaternary) 85%, black)",
				},
				primary: {background: "var(--wf-background-tint)", color: "var(--wf-text-on-color)"},
				primaryHover: {"background-color": "color-mix(in srgb, var(--wf-background-tint) 85%, black)"},
				large: {"border-radius": "var(--wf-radius-pill)", padding: "var(--wf-space-m) var(--wf-space-l)"},
			});
		});

		it("scopes light tokens to ._theme-default so the preview stays light in the dark theme", () => {
			expect(cssBlock(styles, "._theme-default")["--wf-background-primary"]).toBe("var(--wf-gray-0)");
		});

		it("drops the local .export-dialog-* rules", () => {
			expect(hasSelector(styles, /\.export-dialog/u)).toBe(false);
		});
	});
});

describe("export entry", () => {
	describe("selectionExportRequest", () => {
		it("exports the selected rows honoring search", () => {
			expect(selectionExportRequest(["a", "b"])).toStrictEqual({nodeIds: ["a", "b"], ignoreSearch: false});
		});
	});

	describe("openMenuExport", () => {
		it("exports the zoomed item without fetching", async () => {
			const open = vi.fn<(request: ExportRequest) => void>();
			const fetchTopLevelIds = vi.fn<() => Promise<string[]>>(async () => Promise.resolve(["x"]));

			await openMenuExport("z", fetchTopLevelIds, open);

			expect([open.mock.calls, fetchTopLevelIds.mock.calls.length]).toStrictEqual([
				[[{nodeIds: ["z"], ignoreSearch: false}]],
				0,
			]);
		});

		it("exports every top-level item ignoring search at Home", async () => {
			const open = vi.fn<(request: ExportRequest) => void>();

			await openMenuExport(null, async () => Promise.resolve(["t1", "t2"]), open);

			expect(open.mock.calls).toStrictEqual([[{nodeIds: ["t1", "t2"], ignoreSearch: true}]]);
		});

		it("never opens with no items", async () => {
			const open = vi.fn<(request: ExportRequest) => void>();

			await openMenuExport(null, async () => Promise.resolve([]), open);

			expect(open.mock.calls).toStrictEqual([]);
		});
	});

	describe("filterBySearch", () => {
		it("keeps the roots and only the descendants the search shows", () => {
			const tree = [
				{
					id: "r",
					children: [
						{id: "hit", children: [{id: "deep", children: []}]},
						{id: "miss", children: []},
					],
				},
			];

			expect(filterBySearch(tree, (id) => id === "hit")).toStrictEqual([
				{id: "r", children: [{id: "hit", children: []}]},
			]);
		});
	});
});

describe("export tree route", () => {
	const migrationsFolder = join(import.meta.dirname, "../../shared/src/db/migrations");

	function apiNode(
		id: string,
		parentId: string | null,
		priority: number,
		extra: Partial<WorkflowyNode> & {completedAt?: number} = {},
	): WorkflowyNode {
		return {
			id,
			name: id,
			note: null,
			parent_id: parentId,
			priority,
			createdAt: 100,
			modifiedAt: 200,
			completed: extra.completedAt !== undefined,
			...extra,
		};
	}

	function setup() {
		const sqlite = new DatabaseConstructor(":memory:");
		const db = drizzle(sqlite, {schema});
		migrate(db, {migrationsFolder});
		const cacheService = new CacheService(db);
		const ctx = {db, cacheService} as unknown as ServerContext;
		const app = new Hono<AppEnv>();
		app.use("*", async (c, next) => {
			c.set("ctx", ctx);
			await next();
		});
		app.route("/", httpAppFor(ctx));
		const insert = (node: WorkflowyNode) => {
			cacheService.insertNode(node, node.parent_id ?? null);
		};
		const post = async (body: unknown) => {
			const res = await app.fetch(
				new Request("http://x/api/v1/nodes/export-tree", {
					method: "POST",
					headers: {"content-type": "application/json"},
					body: JSON.stringify(body),
				}),
			);
			return {status: res.status, body: await res.json()};
		};
		const mirror = (mirrorId: string, parentId: string, originalId: string) => {
			insert(apiNode(mirrorId, parentId, 9));
			sqlite
				.prepare("INSERT INTO mirrors (mirror_id, original_id, system_from, system_to) VALUES (?, ?, ?, ?)")
				.run(mirrorId, originalId, "2000-01-01T00:00:00.000Z", FAR_FUTURE_DATE);
		};
		const metadata = (nodeId: string, json: Record<string, unknown>) => {
			storeInternalMetadata(db, new Map([[nodeId, json]]));
		};
		return {insert, post, mirror, metadata};
	}

	function item(id: string, children: unknown[] = [], extra: Record<string, unknown> = {}) {
		return {id, name: id, note: "", layoutMode: null, numberedStart: null, completed: false, ...extra, children};
	}

	describe("POST /api/v1/nodes/export-tree", () => {
		it("returns the subtree in priority order and drops completed descendants unless asked", async () => {
			const {insert, post} = setup();
			insert(apiNode("A", null, 0));
			insert(apiNode("B", "A", 0, {completedAt: 300}));
			insert(apiNode("C", "A", 1));
			insert(apiNode("D", "C", 0));

			await expect(post({ids: ["A"], includeCompleted: false})).resolves.toStrictEqual({
				status: 200,
				body: {items: [item("A", [item("C", [item("D")])])]},
			});
			await expect(post({ids: ["A"], includeCompleted: true})).resolves.toStrictEqual({
				status: 200,
				body: {items: [item("A", [item("B", [], {completed: true}), item("C", [item("D")])])]},
			});
		});

		it("keeps a completed root and carries layout mode, numbered start and the raw note", async () => {
			const {insert, post, metadata} = setup();
			insert(
				apiNode("T", null, 0, {
					completedAt: 300,
					name: "Table",
					note: "a <b>x</b>",
					data: {layoutMode: "table"},
				}),
			);
			insert(apiNode("R", "T", 0));
			insert(apiNode("C", "R", 0));
			metadata("R", {numbered_start: 4});

			await expect(post({ids: ["T"], includeCompleted: false})).resolves.toStrictEqual({
				status: 200,
				body: {
					items: [
						item("T", [item("R", [item("C")], {numberedStart: 4})], {
							name: "Table",
							note: "a <b>x</b>",
							layoutMode: "table",
							completed: true,
						}),
					],
				},
			});
		});

		it("gives a mirror its original's text and children and stops a mirror inside its own original", async () => {
			const {insert, post, mirror} = setup();
			insert(apiNode("O", null, 0, {name: "Original"}));
			insert(apiNode("K", "O", 0));
			insert(apiNode("P", null, 1));
			mirror("M", "P", "O");
			mirror("Loop", "O", "O");

			const result = await post({ids: ["P"], includeCompleted: false});

			expect(result).toStrictEqual({
				status: 200,
				body: {
					items: [
						item("P", [
							item("M", [item("K"), item("Loop", [], {name: "Original"})], {
								name: "Original",
								layoutMode: null,
							}),
						]),
					],
				},
			});
		});

		it("rejects a body without string ids", async () => {
			const {post} = setup();

			await expect(post({ids: [1], includeCompleted: true})).resolves.toStrictEqual({
				status: 400,
				body: {error: "ids must be an array of strings"},
			});
		});
	});
});
