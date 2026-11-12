import {describe, expect, it, expectTypeOf} from "vite-plus/test";
import {z} from "zod";
import {TreeNotSeeded} from "@outlinedb/shared/internal";
import {fail, ok, defineOp} from "../src/server/ops/define.js";
import {createHttpApp, parseInput, toResponse} from "../src/server/http/app.js";
import {inProcessStore} from "../src/server/store.js";
import type {ServerContext} from "../src/server/context.js";
import type {OpInput, OpOutput} from "../src/server/ops/index.js";
import type {TagColorName} from "../src/tag-colors.js";
import type {
	BacklinksResponse,
	ExportTreeItem,
	FoundDatesResponse,
	HomeResponse,
	MirrorsResponse,
	NodeChangesResponse,
	NodeResponse,
	OutlineViewResponse,
	SubtreeItem,
	UpdateNodeResponse,
} from "../src/node-types.js";

describe("op framework", () => {
	const ctx = {} as ServerContext;

	async function summary(response: Response) {
		return {
			status: response.status,
			body: await response.text(),
			etag: response.headers.get("ETag"),
			location: response.headers.get("Location"),
			timing: response.headers.get("Server-Timing"),
		};
	}

	describe("toResponse", () => {
		it("returns 200 with the JSON value", async () => {
			await expect(summary(toResponse(ok({a: 1})))).resolves.toStrictEqual({
				status: 200,
				body: '{"a":1}',
				etag: null,
				location: null,
				timing: null,
			});
		});

		it("returns 204 for null", async () => {
			await expect(summary(toResponse(ok(null)))).resolves.toStrictEqual({
				status: 204,
				body: "",
				etag: null,
				location: null,
				timing: null,
			});
		});

		it("returns 201 with the JSON body for a created resource", async () => {
			await expect(summary(toResponse(ok({key: "k"}, {created: true})))).resolves.toStrictEqual({
				status: 201,
				body: '{"key":"k"}',
				etag: null,
				location: null,
				timing: null,
			});
		});

		it("returns 302 with a Location for a redirect", async () => {
			await expect(summary(toResponse(ok(null, {redirect: "/elsewhere"})))).resolves.toStrictEqual({
				status: 302,
				body: "",
				etag: null,
				location: "/elsewhere",
				timing: null,
			});
		});

		it("returns 304 with the ETag when not modified", async () => {
			await expect(summary(toResponse(ok(null, {etag: '"v1"', notModified: true})))).resolves.toStrictEqual({
				status: 304,
				body: "",
				etag: '"v1"',
				location: null,
				timing: null,
			});
		});

		it("sets ETag and Server-Timing on a 200", async () => {
			await expect(
				summary(toResponse(ok([1], {etag: '"v2"', timing: ["db;dur=1", "snap;dur=2"]}))),
			).resolves.toStrictEqual({
				status: 200,
				body: "[1]",
				etag: '"v2"',
				location: null,
				timing: "db;dur=1, snap;dur=2",
			});
		});

		it("returns the error body and status for a failure", async () => {
			await expect(summary(toResponse(fail(503, {error: "INTERNAL_API_NOT_CONFIGURED"})))).resolves.toStrictEqual(
				{
					status: 503,
					body: '{"error":"INTERNAL_API_NOT_CONFIGURED"}',
					etag: null,
					location: null,
					timing: null,
				},
			);
		});
	});

	describe("parseInput", () => {
		const schema = z.object({keys: z.array(z.string())});

		it("returns the parsed value", () => {
			expect(parseInput(schema, {keys: ["a"]}, {error: "bad"})).toStrictEqual({ok: true, value: {keys: ["a"]}});
		});

		it("returns a 400 with the given body on a miss", () => {
			expect(parseInput(schema, {keys: 1}, {error: "body must be {keys: string[]}"})).toStrictEqual({
				ok: false,
				status: 400,
				body: {error: "body must be {keys: string[]}"},
			});
		});
	});

	describe("inProcessStore", () => {
		const ops = {
			double: defineOp({
				input: z.object({n: z.number()}),
				output: z.number(),
				run: (_ctx, input) => ok(input.n * 2),
			}),
			boom: defineOp({
				input: z.object({}),
				output: z.null(),
				run: () => {
					throw new Error("bug");
				},
			}),
			unseeded: defineOp({
				input: z.object({}),
				output: z.null(),
				run: () => {
					throw new TreeNotSeeded();
				},
			}),
		};

		it("runs the op and returns its result", async () => {
			await expect(inProcessStore(ctx, ops).call("double" as never, {n: 2} as never)).resolves.toStrictEqual({
				ok: true,
				value: 4,
			});
		});

		it("turns a thrown error into a 500", async () => {
			await expect(inProcessStore(ctx, ops).call("boom" as never, {} as never)).resolves.toStrictEqual({
				ok: false,
				status: 500,
				body: "Internal Server Error",
			});
		});

		it("turns a tree resync error into a 503 naming the cause", async () => {
			await expect(inProcessStore(ctx, ops).call("unseeded" as never, {} as never)).resolves.toStrictEqual({
				ok: false,
				status: 503,
				body: {
					error: "The local cache has no Workflowy transaction id to sync from; run './bin/run.js cache import-api' to seed it",
				},
			});
		});

		it("returns 404 for an unknown op", async () => {
			await expect(inProcessStore(ctx, ops).call("nope" as never, {} as never)).resolves.toStrictEqual({
				ok: false,
				status: 404,
				body: {error: "Unknown op nope"},
			});
		});
	});

	describe("createHttpApp", () => {
		it("serves /health without touching the store", async () => {
			const app = createHttpApp({
				resolveStore: () => {
					throw new Error("unused");
				},
			});
			const response = await app.request("/health");
			expect({status: response.status, body: await response.json()}).toStrictEqual({
				status: 200,
				body: {status: "ok"},
			});
		});

		it("serves /api/auth-config as not hosted, without touching the store", async () => {
			const app = createHttpApp({
				resolveStore: () => {
					throw new Error("unused");
				},
			});
			const response = await app.request("/api/auth-config");
			expect({status: response.status, body: await response.json()}).toStrictEqual({
				status: 200,
				body: {hosted: false},
			});
		});
	});
});

describe("op types", () => {
	describe("OpInput and OpOutput pin the client-facing op types", () => {
		it("account.get takes no fields and returns the account", () => {
			expectTypeOf<OpInput<"account.get">>().toEqualTypeOf<Record<string, never>>();
			expectTypeOf<OpOutput<"account.get">>().toEqualTypeOf<{
				userId: string;
				joinedAt: string;
				fullName: string | null;
				email: string;
			}>();
		});

		it("nodes.create takes a name and an optional parent (Home when omitted) and slot fields", () => {
			expectTypeOf<OpInput<"nodes.create">>().toEqualTypeOf<{
				parent_id?: string | null | undefined;
				name: string;
				note?: string | undefined;
				layoutMode?: string | undefined;
				index?: number | undefined;
				position?: number | undefined;
				after_id?: string | null | undefined;
				id?: string | undefined;
			}>();
		});

		it("expansion.get takes an optional version", () => {
			expectTypeOf<OpInput<"expansion.get">>().toEqualTypeOf<{version?: string | undefined}>();
		});

		it("output schemas type the small ops' values", () => {
			expectTypeOf<OpOutput<"tags.set">>().toEqualTypeOf<{name: string; color: TagColorName}>();
			expectTypeOf<OpOutput<"tags.list">>().toEqualTypeOf<{colors: Record<string, string>}>();
			expectTypeOf<OpOutput<"stars.remove">>().toEqualTypeOf<null>();
			expectTypeOf<OpOutput<"expansion.leftBarGet">>().toEqualTypeOf<{keys: string[]}>();
			expectTypeOf<OpOutput<"tagIndex.autocomplete">>().toEqualTypeOf<{tags: {tag: string; count: number}[]}>();
			expectTypeOf<OpOutput<"changes.list">["cutoffDate"]>().toEqualTypeOf<string>();
		});

		it("output schemas type the node ops' values", () => {
			expectTypeOf<OpOutput<"nodes.get">>().toEqualTypeOf<{node: NodeResponse}>();
			expectTypeOf<OpOutput<"nodes.list">>().toEqualTypeOf<{nodes: NodeResponse[]}>();
			expectTypeOf<OpOutput<"nodes.children">>().toEqualTypeOf<{children: Record<string, NodeResponse[]>}>();
			expectTypeOf<OpOutput<"nodes.changes">>().toEqualTypeOf<NodeChangesResponse>();
			expectTypeOf<OpOutput<"nodes.view">>().toEqualTypeOf<OutlineViewResponse>();
			expectTypeOf<OpOutput<"nodes.backlinks">>().toEqualTypeOf<BacklinksResponse>();
			expectTypeOf<OpOutput<"nodes.foundDates">>().toEqualTypeOf<FoundDatesResponse>();
			expectTypeOf<OpOutput<"nodes.mirrors">>().toEqualTypeOf<MirrorsResponse>();
			expectTypeOf<OpOutput<"nodes.update">>().toEqualTypeOf<UpdateNodeResponse>();
			expectTypeOf<OpOutput<"nodes.delete">>().toEqualTypeOf<null>();
			expectTypeOf<OpOutput<"nodes.trees">>().toEqualTypeOf<{ids: string[]}>();
			expectTypeOf<OpOutput<"nodes.move">>().toEqualTypeOf<{nodes: NodeResponse[]}>();
			expectTypeOf<OpOutput<"nodes.detachMirror">>().toEqualTypeOf<{node: NodeResponse | null}>();
			expectTypeOf<OpOutput<"nodes.swapMirrorOrigin">>().toEqualTypeOf<
				{swapped: {mirrorId: string; originalId: string}} | {warning: string}
			>();
			expectTypeOf<OpOutput<"home.get">>().toEqualTypeOf<{layoutMode: string}>();
			for (const name of ["nodes.create", "nodes.complete", "nodes.uncomplete", "nodes.restore"] as const) {
				expectTypeOf<OpOutput<typeof name>>().toEqualTypeOf<{node: NodeResponse}>();
			}
			expectTypeOf<OpOutput<"nodes.moveOne">>().toEqualTypeOf<{nodes: NodeResponse[]}>();
			expectTypeOf<OpOutput<"nodes.mirror">>().toEqualTypeOf<{nodes: NodeResponse[]}>();
			expectTypeOf<OpOutput<"nodes.ancestors">>().toEqualTypeOf<{ancestors: NodeResponse[]}>();
			expectTypeOf<OpOutput<"nodes.duplicate">>().toEqualTypeOf<{ids: string[]}>();
			expectTypeOf<OpOutput<"nodes.subtreeIds">>().toEqualTypeOf<{items: SubtreeItem[]}>();
			expectTypeOf<OpOutput<"nodes.exportTree">>().toEqualTypeOf<{items: ExportTreeItem[]}>();
			expectTypeOf<OpOutput<"nodes.setHome">>().toEqualTypeOf<HomeResponse>();
		});

		it("output schemas type the calendar, search, related, files and ladder ops' values", () => {
			expectTypeOf<OpOutput<"calendar.day">>().toEqualTypeOf<{id: string; firstChildId: string | null}>();
			expectTypeOf<OpOutput<"calendar.days">>().toEqualTypeOf<{days: number[]}>();
			expectTypeOf<OpOutput<"calendar.dots">>().toEqualTypeOf<{dateIds: number[]}>();
			expectTypeOf<OpOutput<"calendar.ensure">>().toEqualTypeOf<{
				dayId: string;
				firstChildId: string | null;
				created: string[];
			}>();
			for (const name of ["calendar.settingsGet", "calendar.settingsPut"] as const) {
				expectTypeOf<OpOutput<typeof name>>().toEqualTypeOf<{foundDates: boolean; dayPrefix: boolean}>();
			}
			for (const name of ["calendar.layoutPut", "calendar.layoutUndo"] as const) {
				expectTypeOf<OpOutput<typeof name>>().toEqualTypeOf<{rootId: string; writes: number}>();
			}
			expectTypeOf<OpOutput<"calendar.layoutGet">["applyEnabled"]>().toEqualTypeOf<boolean>();
			expectTypeOf<OpOutput<"calendar.layoutPreview">["steps"][number]["op"]>().toEqualTypeOf<
				"set-calendar" | "set-levels" | "create" | "move" | "delete"
			>();
			expectTypeOf<OpOutput<"files.signedUrl">>().toEqualTypeOf<null>();
			expectTypeOf<OpOutput<"search.helpers">>().toEqualTypeOf<{hashTags: string[]; atTags: string[]}>();
			expectTypeOf<OpOutput<"search.tree">["matchIds"]>().toEqualTypeOf<string[]>();
			expectTypeOf<OpOutput<"search.switcher">["results"][number]["starred"]>().toEqualTypeOf<boolean>();
			expectTypeOf<OpOutput<"search.locations">["results"][number]["labelHtml"]>().toEqualTypeOf<string>();
			expectTypeOf<OpOutput<"search.text">>().toEqualTypeOf<{
				results: {
					id: string;
					name: string | null;
					note: string | null;
					parentPath: string;
					completedAt: number | null;
				}[];
				totalCount: number;
			}>();
			expectTypeOf<OpOutput<"related.find">>().toEqualTypeOf<{
				results: {id: string; name: string | null; note: string | null; distance: number; path: string[]}[];
			}>();
			expectTypeOf<OpOutput<"ladder.read">["ladders"][string]["tiers"][number]["state"]>().toEqualTypeOf<
				"room" | "exact" | "over"
			>();
			expectTypeOf<OpOutput<"ladder.move">["event"]["verb"]>().toEqualTypeOf<
				"move" | "complete" | "uncomplete"
			>();
			expectTypeOf<OpOutput<"ladder.complete">["event"]["nodeId"]>().toEqualTypeOf<string>();
		});
	});
});
