import type {RouterRoute} from "hono/types";
import {z} from "zod";
import {Ops} from "../ops/index.js";
import type {OpName} from "../ops/index.js";

type Schema = Record<string, unknown>;

/**
 * How one route feeds its op. By default path parameters fill the input fields of the same name, a GET or DELETE reads the rest from the
 * query string, and any other method reads the rest from a JSON body; the fields below override that for routes that do otherwise.
 */
interface Binding {
	op: OpName;
	/** Query parameter -> the input field it fills (its schema comes from the op), or the parameter's own schema. */
	query?: Record<string, string | Schema>;
	/** Request header -> the input field it fills. */
	headers?: Record<string, string>;
	/** The input field the whole JSON body fills, for an op that takes the body as one field. */
	body?: string;
	/** The success status when it is not 200. */
	status?: 201 | 302;
	/** Responses the route adds beyond its success and error responses, keyed by status. */
	responses?: Record<string, Schema>;
}

/** The body of every error response: `fail()` and `callOp`'s validation miss both send `{error}`. */
const ERROR_SCHEMA = {
	type: "object",
	properties: {
		error: {type: "string", description: "What went wrong"},
		reconcile: {
			type: "boolean",
			description: "Set by the ladder routes when the client should refetch the ladder before retrying",
		},
	},
	required: ["error"],
};

const ERROR_RESPONSE = {
	description: "Error",
	content: {"application/json": {schema: {$ref: "#/components/schemas/Error"}}},
};

/** Every route `createHttpApp` registers, keyed by method and Hono path; the spec test fails when a route is missing here. */
const BINDINGS: Record<string, Binding> = {
	"GET /api/v1/account": {op: "account.get"},
	"GET /api/v1/account/ai": {op: "account.ai"},
	"GET /api/v1/features": {op: "features.get"},
	"POST /api/v1/features/:codename": {op: "features.set"},
	"GET /api/v1/custom-tree": {op: "customTree.get"},
	"GET /api/v1/calendar/day/:dateId": {op: "calendar.day"},
	"GET /api/v1/calendar/days": {op: "calendar.days"},
	"GET /api/v1/calendar/settings": {op: "calendar.settingsGet"},
	"PUT /api/v1/calendar/settings": {op: "calendar.settingsPut", body: "body"},
	"GET /api/v1/calendar/layout": {op: "calendar.layoutGet"},
	"PUT /api/v1/calendar/layout": {op: "calendar.layoutPut", body: "body"},
	"POST /api/v1/calendar/layout/undo": {op: "calendar.layoutUndo", body: "body"},
	"POST /api/v1/calendar/layout/preview": {op: "calendar.layoutPreview", body: "body"},
	"GET /api/v1/calendar/dots": {op: "calendar.dots"},
	"POST /api/v1/calendar/day/:dateId/ensure": {
		op: "calendar.ensure",
		query: {level: "level", createChild: "createChild"},
	},
	"GET /api/changes": {op: "changes.list"},
	"GET /api/v1/tags/autocomplete": {op: "tagIndex.autocomplete"},
	"GET /api/v1/tags": {op: "tags.list"},
	"PUT /api/v1/tags/:name": {op: "tags.set"},
	"DELETE /api/v1/tags/:name": {op: "tags.clear"},
	"GET /api/v1/expansion": {op: "expansion.get"},
	"PATCH /api/v1/expansion": {op: "expansion.patch"},
	"GET /api/v1/expansion/left-bar": {op: "expansion.leftBarGet"},
	"PATCH /api/v1/expansion/left-bar": {op: "expansion.leftBarPatch"},
	"GET /api/v1/files/:nodeId/:variant{preview|original}": {op: "files.signedUrl", status: 302},
	"GET /api/v1/home": {op: "home.get"},
	"GET /api/v1/inbox/share": {op: "inbox.share", status: 302},
	"GET /api/v1/nodes": {op: "nodes.list", query: {parent_id: "parentId"}},
	"POST /api/v1/nodes/children": {op: "nodes.children"},
	"POST /api/v1/nodes/verify": {op: "nodes.verify"},
	"GET /api/v1/nodes/changes": {op: "nodes.changes"},
	"POST /api/v1/nodes/view": {op: "nodes.view"},
	"POST /api/v1/nodes/export-tree": {op: "nodes.exportTree"},
	"POST /api/v1/nodes/trees": {op: "nodes.trees", status: 201},
	"POST /api/v1/nodes/duplicate": {op: "nodes.duplicate", status: 201},
	"POST /api/v1/nodes/move": {op: "nodes.move"},
	"POST /api/v1/nodes/:id/move": {op: "nodes.moveOne"},
	"POST /api/v1/nodes/mirror": {op: "nodes.mirror", status: 201},
	"POST /api/v1/nodes/:id/detach-mirror": {op: "nodes.detachMirror", status: 201},
	"POST /api/v1/nodes/:id/swap-mirror-origin": {op: "nodes.swapMirrorOrigin"},
	"POST /api/v1/nodes": {op: "nodes.create", status: 201},
	"PATCH /api/v1/nodes/home": {op: "nodes.setHome"},
	"POST /api/v1/nodes/home": {op: "nodes.setHome"},
	"PATCH /api/v1/nodes/:id": {op: "nodes.update"},
	"POST /api/v1/nodes/:id": {op: "nodes.update"},
	"DELETE /api/v1/nodes/:id": {op: "nodes.delete"},
	"POST /api/v1/nodes/:id/complete": {op: "nodes.complete"},
	"POST /api/v1/nodes/:id/uncomplete": {op: "nodes.uncomplete"},
	"POST /api/v1/nodes/:id/restore": {op: "nodes.restore"},
	"GET /api/v1/nodes/:id": {op: "nodes.get"},
	"GET /api/v1/nodes/:id/subtree-ids": {op: "nodes.subtreeIds"},
	"GET /api/v1/nodes/:id/ancestors": {op: "nodes.ancestors"},
	"GET /api/v1/nodes/:id/backlinks": {op: "nodes.backlinks"},
	"GET /api/v1/nodes/:id/found-dates": {op: "nodes.foundDates"},
	"GET /api/v1/nodes/:id/mirrors": {op: "nodes.mirrors"},
	"GET /api/v1/ladder": {op: "ladder.read"},
	"POST /api/v1/ladder/move": {op: "ladder.move"},
	"POST /api/v1/ladder/complete": {op: "ladder.complete"},
	"POST /api/related": {op: "related.find"},
	"GET /api/search/helpers": {op: "search.helpers"},
	"POST /api/search/tree": {op: "search.tree"},
	"POST /api/search/switcher": {op: "search.switcher"},
	"POST /api/search/locations": {
		op: "search.locations",
		responses: {"499": {description: "Client closed request: the client aborted before the search finished"}},
	},
	"POST /api/search": {op: "search.text"},
	"GET /api/v1/stars": {op: "stars.list"},
	"PUT /api/v1/stars/order": {op: "stars.order"},
	"PUT /api/v1/stars/:key": {op: "stars.set", status: 201},
	"DELETE /api/v1/stars/:key": {op: "stars.remove"},
	"PATCH /api/v1/stars/:key": {op: "stars.rename"},
	"GET /api/v1/preferences": {op: "preferences.get"},
	"PATCH /api/v1/preferences": {op: "preferences.patch", body: "patch"},
	"GET /api/v1/whats-new": {op: "whatsNew.get"},
	"POST /api/v1/whats-new/read": {op: "whatsNew.markRead"},
};

interface ObjectSchema {
	properties: Record<string, Schema>;
	required: string[];
	rest: Schema;
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): Schema {
	const {$schema: _, ...rest} = z.toJSONSchema(schema, {io, unrepresentable: "any"});
	return rest;
}

/** An op input's JSON Schema split into its fields, the names it requires, and its other keywords. */
function inputFields(op: OpName): ObjectSchema {
	const {properties, required, ...rest} = jsonSchema(Ops[op].input, "input");
	return {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an object schema's properties are schemas
		properties: (properties ?? {}) as Record<string, Schema>,
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an object schema's required is a list of names
		required: (required ?? []) as string[],
		rest,
	};
}

/** `/a/:id/:variant{x|y}` -> `/a/{id}/{variant}`. */
function openApiPath(path: string): string {
	return path.replaceAll(/:(\w+)(\{[^}]*\})?/gu, "{$1}");
}

function pathParamNames(path: string): string[] {
	return [...path.matchAll(/:(\w+)/gu)].map((match) => match[1] ?? "");
}

function parameter(name: string, location: string, required: boolean, schema: Schema): Schema {
	return {name, in: location, required, schema};
}

function requestBody(binding: Binding, input: ObjectSchema, consumed: Set<string>, method: string): Schema | undefined {
	if (binding.body !== undefined) {
		return {
			required: input.required.includes(binding.body),
			content: {"application/json": {schema: input.properties[binding.body] ?? {}}},
		};
	}
	if (method === "GET" || method === "DELETE") {
		return undefined;
	}
	const fields = Object.entries(input.properties).filter(([name]) => !consumed.has(name));
	if (fields.length === 0) {
		return undefined;
	}
	const required = input.required.filter((name) => !consumed.has(name));
	const schema = {
		...input.rest,
		properties: Object.fromEntries(fields),
		...(required.length > 0 ? {required} : {}),
	};
	return {required: required.length > 0, content: {"application/json": {schema}}};
}

function responses(binding: Binding): Schema {
	if (binding.status === 302) {
		return {
			"302": {description: "Redirect to the signed URL", headers: {Location: {schema: {type: "string"}}}},
			...binding.responses,
			default: ERROR_RESPONSE,
		};
	}
	const {output} = Ops[binding.op];
	const success = {
		description: binding.status === 201 ? "Created" : "OK",
		content: {"application/json": {schema: jsonSchema(output, "output")}},
	};
	return {
		[String(binding.status ?? 200)]: success,
		...(output.safeParse(null).success ? {"204": {description: "No content"}} : {}),
		...binding.responses,
		default: ERROR_RESPONSE,
	};
}

function operation(method: string, path: string, binding: Binding, operationId: string): Schema {
	const input = inputFields(binding.op);
	const pathNames = pathParamNames(path);
	const parameters = pathNames.map((name) =>
		parameter(name, "path", true, input.properties[name] ?? {type: "string"}),
	);
	const consumed = new Set(pathNames);
	const query =
		binding.query ??
		(method === "GET" || method === "DELETE"
			? Object.fromEntries(
					Object.keys(input.properties)
						.filter((name) => !consumed.has(name))
						.map((name) => [name, name]),
				)
			: {});
	for (const [name, source] of Object.entries(query)) {
		if (typeof source === "string") {
			consumed.add(source);
			parameters.push(parameter(name, "query", input.required.includes(source), input.properties[source] ?? {}));
		} else {
			parameters.push(parameter(name, "query", false, source));
		}
	}
	for (const [name, field] of Object.entries(binding.headers ?? {})) {
		consumed.add(field);
		parameters.push(parameter(name, "header", false, input.properties[field] ?? {}));
	}
	const body = requestBody(binding, input, consumed, method);
	return {
		operationId,
		tags: [binding.op.split(".")[0] ?? binding.op],
		...(parameters.length > 0 ? {parameters} : {}),
		...(body === undefined ? {} : {requestBody: body}),
		responses: responses(binding),
	};
}

/** The OpenAPI 3.1 document for `routes`, with request and response schemas from each route's op. */
export function openApiDocument(routes: readonly RouterRoute[]): Schema {
	const bound = routes
		.filter((route) => route.method !== "ALL")
		.flatMap((route) => {
			const binding = BINDINGS[`${route.method} ${route.path}`];
			return binding === undefined ? [] : [{method: route.method, path: route.path, binding}];
		});
	const opCounts = new Map<OpName, number>();
	for (const {binding} of bound) {
		opCounts.set(binding.op, (opCounts.get(binding.op) ?? 0) + 1);
	}
	const paths: Record<string, Record<string, Schema>> = {};
	for (const {method, path, binding} of bound) {
		const operationId = (opCounts.get(binding.op) ?? 0) > 1 ? `${binding.op}:${method.toLowerCase()}` : binding.op;
		const key = openApiPath(path);
		paths[key] = {...paths[key], [method.toLowerCase()]: operation(method, path, binding, operationId)};
	}
	return {
		openapi: "3.1.0",
		info: {title: "Workflowy API", version: "1.0.0"},
		paths,
		components: {schemas: {Error: ERROR_SCHEMA}},
	};
}

const SWAGGER_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/";

/** The Swagger UI page for the document at `/api/openapi.json`. */
export const API_DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Workflowy API</title>
<link rel="stylesheet" href="${SWAGGER_UI}swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${SWAGGER_UI}swagger-ui-bundle.js"></script>
<script>
SwaggerUIBundle({
	url: "/api/openapi.json",
	dom_id: "#swagger-ui",
});
</script>
</body>
</html>
`;
