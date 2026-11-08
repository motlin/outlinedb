import {describe, expect, it} from "vite-plus/test";
import {z} from "zod";
import {createHttpApp} from "../src/server/http/app.js";
import {Ops} from "../src/server/ops/index.js";
import {inProcessStore} from "../src/server/store.js";
import type {ServerContext} from "../src/server/context.js";

interface Operation {
	operationId: string;
	parameters?: {name: string; in: string}[];
	responses: Record<string, unknown>;
}

interface Spec {
	openapi: string;
	paths: Record<string, Record<string, Operation>>;
	components?: {schemas?: Record<string, unknown>};
}

const ERROR_REF = {description: "Error", content: {"application/json": {schema: {$ref: "#/components/schemas/Error"}}}};

const DOC_PATHS = new Set(["/health", "/api/auth-config", "/api/openapi.json", "/api/docs"]);

function app() {
	return createHttpApp({resolveStore: () => inProcessStore({} as unknown as ServerContext)});
}

/** `/a/:id/:variant{x|y}` -> `/a/{id}/{variant}`. */
function openApiPath(path: string): string {
	return path.replaceAll(/:(\w+)(\{[^}]*\})?/gu, "{$1}");
}

function withoutDialect({$schema: _, ...schema}: Record<string, unknown>): Record<string, unknown> {
	return schema;
}

async function spec(): Promise<Spec> {
	const response = await app().fetch(new Request("http://x/api/openapi.json"));
	expect(response.status).toBe(200);
	return (await response.json()) as Spec;
}

describe("GET /api/openapi.json", () => {
	it("lists every registered API route under its method and path, and nothing else", async () => {
		const registered = app()
			.routes.filter((route) => route.method !== "ALL" && !DOC_PATHS.has(route.path))
			.map((route) => `${route.method.toLowerCase()} ${openApiPath(route.path)}`);
		const {openapi, paths} = await spec();
		const documented = Object.entries(paths).flatMap(([path, operations]) =>
			Object.keys(operations).map((method) => `${method} ${path}`),
		);

		expect({openapi, count: documented.length, documented: new Set(documented)}).toStrictEqual({
			openapi: "3.1.0",
			count: registered.length,
			documented: new Set(registered),
		});
	});

	it("names each path parameter of each operation, and every operationId is a registered op", async () => {
		const {paths} = await spec();
		const mismatches = Object.entries(paths).flatMap(([path, operations]) =>
			Object.entries(operations).flatMap(([method, operation]) => {
				const expected = [...path.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]);
				const actual = (operation.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
				const opName = operation.operationId.split(":")[0] ?? "";
				return JSON.stringify(expected) === JSON.stringify(actual) && opName in Ops
					? []
					: [{method, path, operationId: operation.operationId, expected, actual}];
			}),
		);

		expect(mismatches).toStrictEqual([]);
	});

	it("documents a body route with its path parameter, request body and response schemas", async () => {
		const {paths} = await spec();
		const colorSchema = z.toJSONSchema(Ops["tags.set"].input, {io: "input", unrepresentable: "any"}) as unknown as {
			properties: {color: unknown};
		};

		expect(paths["/api/v1/tags/{name}"]?.put).toStrictEqual({
			operationId: "tags.set",
			tags: ["tags"],
			parameters: [{name: "name", in: "path", required: true, schema: {type: "string"}}],
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: {
							type: "object",
							properties: {color: colorSchema.properties.color},
							required: ["color"],
						},
					},
				},
			},
			responses: {
				"200": {
					description: "OK",
					content: {
						"application/json": {
							schema: withoutDialect(
								z.toJSONSchema(Ops["tags.set"].output, {io: "output", unrepresentable: "any"}),
							),
						},
					},
				},
				default: ERROR_REF,
			},
		});
	});

	it("defines the shared {error} body and references it from every error response", async () => {
		const {paths, components} = await spec();
		const errorResponses = Object.entries(paths).flatMap(([path, operations]) =>
			Object.entries(operations).flatMap(([method, operation]) =>
				Object.entries(operation.responses)
					.filter(([status]) => status === "default" || /^[45]/u.test(status))
					.filter(([status]) => status !== "499")
					.map(([status, response]) => ({method, path, status, response})),
			),
		);

		expect({
			error: components?.schemas?.Error,
			unshared: errorResponses.filter(({response}) => JSON.stringify(response) !== JSON.stringify(ERROR_REF)),
			count: errorResponses.length > 0,
		}).toStrictEqual({
			error: {
				type: "object",
				properties: {
					error: {type: "string", description: "What went wrong"},
					reconcile: {
						type: "boolean",
						description:
							"Set by the ladder routes when the client should refetch the ladder before retrying",
					},
				},
				required: ["error"],
			},
			unshared: [],
			count: true,
		});
	});

	it("documents the search locations 499 and the expansion change feed's version parameter", async () => {
		const {paths} = await spec();
		expect({
			expansion: paths["/api/v1/expansion"]?.get?.parameters,
			locations: paths["/api/search/locations"]?.post?.responses["499"],
		}).toStrictEqual({
			expansion: [
				{name: "version", in: "query", required: false, schema: {type: "string", pattern: "^[0-9a-f]{16}$"}},
			],
			locations: {description: "Client closed request: the client aborted before the search finished"},
		});
	});

	it("documents a query route's parameters from its op input", async () => {
		const {paths} = await spec();

		expect(paths["/api/v1/calendar/dots"]?.get?.parameters).toStrictEqual([
			{name: "from", in: "query", required: false, schema: {type: "string"}},
			{name: "to", in: "query", required: false, schema: {type: "string"}},
		]);
	});
});

describe("GET /api/docs", () => {
	it("serves an HTML API reference that loads the spec", async () => {
		const response = await app().fetch(new Request("http://x/api/docs"));
		const html = await response.text();

		expect({
			status: response.status,
			type: response.headers.get("content-type"),
			loadsSpec: html.includes('url: "/api/openapi.json"'),
			pinnedCdn: html.includes("https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/"),
		}).toStrictEqual({status: 200, type: "text/html; charset=UTF-8", loadsSpec: true, pinnedCdn: true});
	});
});
