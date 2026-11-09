import {beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {Hono} from "hono";
import type * as SharedCache from "@outlinedb/shared/cache";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const createNode = vi.hoisted(() => vi.fn<SharedCache.WorkflowyWriteThroughClient["createNode"]>());

vi.mock("@outlinedb/shared/cache", async (importOriginal) => {
	const actual = await importOriginal<typeof SharedCache>();
	return {
		...actual,
		WorkflowyWriteThroughClient: class {
			createNode = createNode;
		},
	};
});

function makeApp() {
	const ctx = {
		apiKey: "test-key",
		config: {} as ServerContext["config"],
		cacheService: {getChildren: () => []},
	} as unknown as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.route("/", httpAppFor(ctx));
	return app;
}

async function post(body: unknown): Promise<Response> {
	return makeApp().fetch(
		new Request("http://x/api/v1/nodes", {
			method: "POST",
			headers: {"content-type": "application/json"},
			body: JSON.stringify(body),
		}),
	);
}

describe("POST /api/v1/nodes", () => {
	beforeEach(() => {
		createNode.mockReset();
	});

	it("creates a node with an empty name", async () => {
		createNode.mockResolvedValue({
			id: "n1",
			name: "",
			priority: 0,
			data: {},
			createdAt: 100,
			modifiedAt: 100,
			completedAt: null,
		});

		const res = await post({parent_id: "p", name: ""});

		expect(res.status).toBe(201);
		expect(createNode.mock.calls).toStrictEqual([
			[{parent_id: "p", name: "", note: undefined, layoutMode: undefined, position: "bottom"}],
		]);
		await expect(res.json()).resolves.toStrictEqual({
			node: {
				id: "n1",
				parent_id: "p",
				name: "",
				note: null,
				priority: 0,
				data: {layoutMode: null},
				numberedStart: null,
				createdAt: 100,
				modifiedAt: 100,
				completedAt: null,
				hasChildren: true,
				hasUncompletedChildren: true,
				isMirror: false,
				originalNodeId: null,
				attachment: null,
				defaultToBottom: false,
				calendar: null,
				table: null,
			},
		});
	});

	it("rejects a body with no name", async () => {
		const res = await post({parent_id: "p"});

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toStrictEqual({error: "Invalid request body"});
		expect(createNode.mock.calls).toStrictEqual([]);
	});
});
