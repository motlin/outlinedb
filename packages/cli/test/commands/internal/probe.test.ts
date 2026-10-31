import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {calendarNodeId} from "@workflowy/shared/internal";
import {storeInternalMetadata} from "@workflowy/shared/cache";
import {createDatabase} from "../../../src/db/index.js";
import Probe, {SANDBOX_ID, assertUnderSandbox, expectedMove, typeShape} from "../../../src/commands/internal/probe.js";

const INIT_BODY = {
	projectTreeData: {
		mainProjectTreeInfo: {
			dateJoinedTimestampInSeconds: 1_300_000_000,
			initialMostRecentOperationTransactionId: "1234567",
			ownerId: 42,
		},
		rootProjectMetadata: {},
	},
	settings: {},
	user: {id: 42},
	globals: [["CLIENT_VERSION", 25]],
};

const POLL_BODY = {
	results: [
		{
			new_most_recent_operation_transaction_id: "1234567",
			concurrent_remote_operation_transactions: [],
			error_encountered_in_remote_operations: false,
		},
	],
	new_polling_interval_in_ms: 30_000,
};

interface Recorded {
	path: string;
	body: string | undefined;
}

function respond(pathname: string, pollStatus: number): Response {
	if (pathname === "/ajax_login") {
		return new Response("", {status: 200, headers: {"set-cookie": "sessionid=abc123; Path=/"}});
	}
	if (pathname === "/get_initialization_data") {
		return Response.json(INIT_BODY, {headers: {wfclientid: "2026-10-18 12:00:00.123456"}});
	}
	if (pathname === "/push_and_poll") {
		return pollStatus === 200 ? Response.json(POLL_BODY) : new Response("Forbidden", {status: pollStatus});
	}
	return new Response("not found", {status: 404});
}

function fakeFetch(recorded: Recorded[], pollStatus = 200) {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		recorded.push({path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined});
		return Promise.resolve(respond(url.pathname, pollStatus));
	});
}

describe("internal probe command", () => {
	let tempDir: string;
	let outPath: string;
	let sessionFile: string;
	const savedEnv = {...process.env};

	beforeEach(() => {
		vi.useFakeTimers({toFake: ["Date"]});
		vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-probe-"));
		outPath = path.join(tempDir, "probes.md");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		sessionFile = path.join(tempDir, "workflowy-session");
		process.env.WORKFLOWY_SESSION_FILE = sessionFile;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("refuses to run without --yes-live and makes no request", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", fakeFetch(recorded));
		await expect(Probe.run(["bootstrap", "--out", outPath])).rejects.toThrow(
			"Live probe against workflowy.com: pass --yes-live to run it",
		);
		expect(recorded).toStrictEqual([]);
		expect(fs.existsSync(outPath)).toBe(false);
	});

	it("rejects an unknown step", async () => {
		await expect(Probe.run(["delete-everything", "--yes-live", "--out", outPath])).rejects.toThrow(
			"Expected delete-everything to be one of: bootstrap, poll, error-shape, index, restore, meta, expansion, root-meta, root-meta-set, root-meta-unset, settings",
		);
	});

	it("refuses to run without credentials or a saved session cookie", async () => {
		delete process.env.WORKFLOWY_PASSWORD;
		await expect(Probe.run(["bootstrap", "--yes-live", "--out", outPath])).rejects.toThrow(
			"Set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD in the environment (e.g. from .envrc), or run './bin/run.js internal login' with them set",
		);
	});

	it("bootstrap reuses a saved session cookie without credentials or a login", async () => {
		delete process.env.WORKFLOWY_USERNAME;
		delete process.env.WORKFLOWY_PASSWORD;
		fs.writeFileSync(sessionFile, "sessionid=saved\n");
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", fakeFetch(recorded));
		await Probe.run(["bootstrap", "--yes-live", "--out", outPath]);
		expect(recorded.map((request) => request.path)).toStrictEqual(["/get_initialization_data"]);
	});

	it("bootstrap saves the fresh login cookie to the session file", async () => {
		vi.stubGlobal("fetch", fakeFetch([]));
		await Probe.run(["bootstrap", "--yes-live", "--out", outPath]);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe("sessionid=abc123\n");
	});

	it("bootstrap records client id shape, CLIENT_VERSION and tx id source", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", fakeFetch(recorded));
		await Probe.run(["bootstrap", "--yes-live", "--out", outPath]);
		expect(recorded.map((request) => request.path)).toStrictEqual(["/ajax_login", "/get_initialization_data"]);
		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## bootstrap (2026-10-18T12:00:00.000Z)",
				"",
				"- `wfclientid` header: present, shape `9999-99-99 99:99:99.999999`",
				"- `client_version` used: `25` (from a JSON `globals` CLIENT_VERSION)",
				"- `initialMostRecentOperationTransactionId` with `no_root_children=1`: present, shape `9999999`",
				"- `get_tree_data` fallback needed: no",
				"- `get_user_data` needed for user/settings/root metadata: no",
				"- Requests: `POST /ajax_login` 200; `GET /get_initialization_data` 200 (" +
					`${JSON.stringify(INIT_BODY).length} bytes)`,
				"",
			].join("\n"),
		);
	});

	it("poll sends crosscheck_user_id and records the result keys and size", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", fakeFetch(recorded));
		await Probe.run(["poll", "--yes-live", "--out", outPath]);
		const poll = recorded.find((request) => request.path === "/push_and_poll");
		const form = new URLSearchParams(poll?.body);
		expect([...form.keys()]).toStrictEqual([
			"client_id",
			"client_version",
			"push_poll_id",
			"push_poll_data",
			"timezone",
			"crosscheck_user_id",
		]);
		expect(JSON.parse(form.get("push_poll_data") ?? "")).toStrictEqual([
			{most_recent_operation_transaction_id: "1234567"},
		]);
		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## poll (2026-10-18T12:00:00.000Z)",
				"",
				"- `crosscheck_user_id` sent: yes",
				`- HTTP status: 200 (${JSON.stringify(POLL_BODY).length} bytes)`,
				"- CSRF: not enforced (cookie-only client accepted)",
				"- Response keys: `new_polling_interval_in_ms`, `results`",
				"- `results[0]` keys: `concurrent_remote_operation_transactions`, `error_encountered_in_remote_operations`, `new_most_recent_operation_transaction_id`",
				"- Tx id advanced: no (still current)",
				"- Remote transactions: 0",
				"",
			].join("\n"),
		);
	});

	it("poll --no-crosscheck omits crosscheck_user_id and records a 403 as CSRF enforcement", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", fakeFetch(recorded, 403));
		await Probe.run(["poll", "--no-crosscheck", "--yes-live", "--out", outPath]);
		const poll = recorded.find((request) => request.path === "/push_and_poll");
		expect(new URLSearchParams(poll?.body).has("crosscheck_user_id")).toBe(false);
		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## poll --no-crosscheck (2026-10-18T12:00:00.000Z)",
				"",
				"- `crosscheck_user_id` sent: no",
				"- HTTP status: 403 (9 bytes)",
				"- CSRF: enforced or request refused (403)",
				"- Body (not JSON): `Forbidden`",
				"",
			].join("\n"),
		);
	});
});

describe("assertUnderSandbox", () => {
	it("passes when the sandbox is an ancestor", () => {
		expect(() => {
			assertUnderSandbox(["11111111-0000-0000-0000-000000000000", SANDBOX_ID]);
		}).not.toThrow();
	});

	it("throws when the sandbox is not an ancestor", () => {
		expect(() => {
			assertUnderSandbox(["11111111-0000-0000-0000-000000000000"]);
		}).toThrow(`Refusing to write outside the sandbox: ${SANDBOX_ID} is not an ancestor`);
	});

	it("throws for a node with no ancestors", () => {
		expect(() => {
			assertUnderSandbox([]);
		}).toThrow(`Refusing to write outside the sandbox: ${SANDBOX_ID} is not an ancestor`);
	});
});

const CHILD_ID = "c0ffee00-0000-4000-8000-000000000001";

interface PublicNode {
	id: string;
	name: string;
	parent_id: string | null;
}

function publicNode(node: PublicNode) {
	return {...node, note: null, priority: 0, completed: false, createdAt: 1, modifiedAt: 1, completedAt: null};
}

/** Public API + internal API fake: the child lives under `childParent`; a push renames it when `editApplies`. */
function errorShapeFetch(
	recorded: Recorded[],
	{childParent, editApplies}: {childParent: string; editApplies: boolean},
) {
	const nodes = new Map<string, PublicNode>([
		[SANDBOX_ID, {id: SANDBOX_ID, name: "Sandbox", parent_id: null}],
		[
			"0ther000-0000-4000-8000-000000000000",
			{id: "0ther000-0000-4000-8000-000000000000", name: "Other", parent_id: null},
		],
	]);
	const route = (url: URL, method: string, body: string | undefined): Response => {
		if (url.pathname === "/api/v1/nodes/" && method === "POST") {
			const created = JSON.parse(body ?? "{}") as {name: string};
			nodes.set(CHILD_ID, {id: CHILD_ID, name: created.name, parent_id: childParent});
			return Response.json({item_id: CHILD_ID});
		}
		if (url.pathname === "/api/v1/nodes" && method === "GET") {
			const parent = url.searchParams.get("parent_id");
			return Response.json({
				nodes: [...nodes.values()].filter((node) => node.parent_id === parent).map(publicNode),
			});
		}
		const match = /^\/api\/v1\/nodes\/([^/]+)$/u.exec(url.pathname);
		if (match?.[1] !== undefined) {
			const node = nodes.get(match[1]);
			if (method === "DELETE") {
				nodes.delete(match[1]);
				return Response.json({status: "ok"});
			}
			return node === undefined
				? new Response("not found", {status: 404})
				: Response.json({node: publicNode(node)});
		}
		if (url.pathname === "/push_and_poll") {
			const child = nodes.get(CHILD_ID);
			if (editApplies && child !== undefined) {
				child.name = "probe error-shape: renamed";
			}
			return Response.json({results: [{error: "error_encountered_running_operations"}]});
		}
		return respond(url.pathname, 200);
	};
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : undefined;
		recorded.push({path: `${method} ${url.pathname}`, body});
		return Promise.resolve(route(url, method, body));
	});
}

describe("internal probe error-shape", () => {
	let tempDir: string;
	let outPath: string;
	const savedEnv = {...process.env};

	beforeEach(() => {
		vi.useFakeTimers({toFake: ["Date"]});
		vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-probe-"));
		outPath = path.join(tempDir, "probes.md");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
		process.env.WORKFLOWY_API_KEY = "test-key";
		delete process.env.WORKFLOWY_API_URL;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("pushes an edit then a move into a missing parent in one batch, records the error, and deletes the child", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", errorShapeFetch(recorded, {childParent: SANDBOX_ID, editApplies: true}));
		await Probe.run(["error-shape", "--yes-live", "--out", outPath]);

		expect(recorded.map((request) => request.path)).toStrictEqual([
			"POST /api/v1/nodes/",
			`GET /api/v1/nodes/${CHILD_ID}`,
			"GET /api/v1/nodes",
			"POST /ajax_login",
			"GET /get_initialization_data",
			"POST /push_and_poll",
			`GET /api/v1/nodes/${CHILD_ID}`,
			`DELETE /api/v1/nodes/${CHILD_ID}`,
		]);
		const push = recorded.find((request) => request.path === "POST /push_and_poll");
		const pushData = JSON.parse(new URLSearchParams(push?.body).get("push_poll_data") ?? "") as {
			operations: {type: string; data: Record<string, unknown>}[];
		}[];
		expect(pushData[0]?.operations.map((op) => [op.type, op.data.projectid])).toStrictEqual([
			["edit", CHILD_ID],
			["move", CHILD_ID],
		]);
		expect(pushData[0]?.operations[0]?.data.name).toBe("probe error-shape: renamed");
		expect(pushData[0]?.operations[1]?.data.parentid).not.toBe(SANDBOX_ID);

		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## error-shape (2026-10-18T12:00:00.000Z)",
				"",
				"- Fixture: fresh child created under the sandbox via the public API; ancestors verified",
				"- Batch: `edit` (rename the child) then `move` (into a nonexistent parent), one `/push_and_poll`",
				"- HTTP status: 200",
				"- `results[0]` keys: `error`",
				"- `results[0].error`: `error_encountered_running_operations`",
				"- `server_run_operation_transaction_json`: absent",
				"- Tx id advanced: unknown",
				"- First op (`edit`) applied: yes (name changed)",
				"- Child parent after push: sandbox",
				"- Cleanup: child deleted via the public API",
				"",
			].join("\n"),
		);
	});

	it("records an edit the server did not apply", async () => {
		vi.stubGlobal("fetch", errorShapeFetch([], {childParent: SANDBOX_ID, editApplies: false}));
		await Probe.run(["error-shape", "--yes-live", "--out", outPath]);
		expect(fs.readFileSync(outPath, "utf8")).toContain("- First op (`edit`) applied: no (name unchanged)\n");
	});

	it("refuses to push when the created child is not under the sandbox, and writes nothing else", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal(
			"fetch",
			errorShapeFetch(recorded, {childParent: "0ther000-0000-4000-8000-000000000000", editApplies: true}),
		);
		await expect(Probe.run(["error-shape", "--yes-live", "--out", outPath])).rejects.toThrow(
			`Refusing to write outside the sandbox: ${SANDBOX_ID} is not an ancestor`,
		);
		expect(recorded.map((request) => request.path)).toStrictEqual([
			"POST /api/v1/nodes/",
			`GET /api/v1/nodes/${CHILD_ID}`,
			"GET /api/v1/nodes/0ther000-0000-4000-8000-000000000000",
		]);
		expect(fs.existsSync(outPath)).toBe(false);
	});

	it("requires WORKFLOWY_API_KEY", async () => {
		delete process.env.WORKFLOWY_API_KEY;
		await expect(Probe.run(["error-shape", "--yes-live", "--out", outPath])).rejects.toThrow(
			"WORKFLOWY_API_KEY environment variable is required",
		);
	});
});

describe("internal probe index", () => {
	let tempDir: string;
	let outPath: string;
	const savedEnv = {...process.env};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-probe-"));
		outPath = path.join(tempDir, "probes.md");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
		process.env.WORKFLOWY_API_KEY = "test-key";
		process.env.WORKFLOWY_DB_PATH = path.join(tempDir, "cache.sqlite");
		delete process.env.WORKFLOWY_API_URL;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("refuses to write when the fixture parent is not under the sandbox, and writes nothing else", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal(
			"fetch",
			errorShapeFetch(recorded, {childParent: "0ther000-0000-4000-8000-000000000000", editApplies: false}),
		);
		await expect(Probe.run(["index", "--yes-live", "--out", outPath])).rejects.toThrow(
			`Refusing to write outside the sandbox: ${SANDBOX_ID} is not an ancestor`,
		);
		expect(recorded.map((request) => request.path)).toStrictEqual([
			"POST /api/v1/nodes/",
			`GET /api/v1/nodes/${CHILD_ID}`,
			"GET /api/v1/nodes/0ther000-0000-4000-8000-000000000000",
		]);
		expect(fs.existsSync(outPath)).toBe(false);
	});

	it("requires WORKFLOWY_API_KEY", async () => {
		delete process.env.WORKFLOWY_API_KEY;
		await expect(Probe.run(["index", "--yes-live", "--out", outPath])).rejects.toThrow(
			"WORKFLOWY_API_KEY environment variable is required",
		);
	});
});

describe("internal probe restore", () => {
	let tempDir: string;
	let outPath: string;
	const savedEnv = {...process.env};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-probe-"));
		outPath = path.join(tempDir, "probes.md");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
		process.env.WORKFLOWY_API_KEY = "test-key";
		process.env.WORKFLOWY_DB_PATH = path.join(tempDir, "cache.sqlite");
		delete process.env.WORKFLOWY_API_URL;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("refuses to write when the fixture parent is not under the sandbox, and writes nothing else", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal(
			"fetch",
			errorShapeFetch(recorded, {childParent: "0ther000-0000-4000-8000-000000000000", editApplies: false}),
		);
		await expect(Probe.run(["restore", "--yes-live", "--out", outPath])).rejects.toThrow(
			`Refusing to write outside the sandbox: ${SANDBOX_ID} is not an ancestor`,
		);
		expect(recorded.map((request) => request.path)).toStrictEqual([
			"POST /api/v1/nodes/",
			`GET /api/v1/nodes/${CHILD_ID}`,
			"GET /api/v1/nodes/0ther000-0000-4000-8000-000000000000",
		]);
		expect(fs.existsSync(outPath)).toBe(false);
	});

	it("requires WORKFLOWY_API_KEY", async () => {
		delete process.env.WORKFLOWY_API_KEY;
		await expect(Probe.run(["restore", "--yes-live", "--out", outPath])).rejects.toThrow(
			"WORKFLOWY_API_KEY environment variable is required",
		);
	});
});

describe("internal probe meta", () => {
	let tempDir: string;
	let outPath: string;
	const savedEnv = {...process.env};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-probe-"));
		outPath = path.join(tempDir, "probes.md");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
		process.env.WORKFLOWY_API_KEY = "test-key";
		process.env.WORKFLOWY_DB_PATH = path.join(tempDir, "cache.sqlite");
		delete process.env.WORKFLOWY_API_URL;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("refuses to write when the fixture is not under the sandbox, and writes nothing else", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal(
			"fetch",
			errorShapeFetch(recorded, {childParent: "0ther000-0000-4000-8000-000000000000", editApplies: false}),
		);
		await expect(Probe.run(["meta", "--yes-live", "--out", outPath])).rejects.toThrow(
			`Refusing to write outside the sandbox: ${SANDBOX_ID} is not an ancestor`,
		);
		expect(recorded.map((request) => request.path)).toStrictEqual([
			"POST /api/v1/nodes/",
			`GET /api/v1/nodes/${CHILD_ID}`,
			"GET /api/v1/nodes/0ther000-0000-4000-8000-000000000000",
		]);
		expect(fs.existsSync(outPath)).toBe(false);
	});

	it("requires WORKFLOWY_API_KEY", async () => {
		delete process.env.WORKFLOWY_API_KEY;
		await expect(Probe.run(["meta", "--yes-live", "--out", outPath])).rejects.toThrow(
			"WORKFLOWY_API_KEY environment variable is required",
		);
	});
});

describe("internal probe expansion", () => {
	let tempDir: string;
	let outPath: string;
	const savedEnv = {...process.env};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-probe-"));
		outPath = path.join(tempDir, "probes.md");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
		process.env.WORKFLOWY_API_KEY = "test-key";
		process.env.WORKFLOWY_DB_PATH = path.join(tempDir, "cache.sqlite");
		delete process.env.WORKFLOWY_API_URL;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("refuses to push an expansion when the fixture is not under the sandbox, and writes nothing else", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal(
			"fetch",
			errorShapeFetch(recorded, {childParent: "0ther000-0000-4000-8000-000000000000", editApplies: false}),
		);
		await expect(Probe.run(["expansion", "--yes-live", "--out", outPath])).rejects.toThrow(
			`Refusing to write outside the sandbox: ${SANDBOX_ID} is not an ancestor`,
		);
		expect(recorded.map((request) => request.path)).toStrictEqual([
			"POST /api/v1/nodes/",
			`GET /api/v1/nodes/${CHILD_ID}`,
			"GET /api/v1/nodes/0ther000-0000-4000-8000-000000000000",
		]);
		expect(fs.existsSync(outPath)).toBe(false);
	});

	it("requires WORKFLOWY_API_KEY", async () => {
		delete process.env.WORKFLOWY_API_KEY;
		await expect(Probe.run(["expansion", "--yes-live", "--out", outPath])).rejects.toThrow(
			"WORKFLOWY_API_KEY environment variable is required",
		);
	});
});

describe("expectedMove", () => {
	it("models insertion slots counted before the moved ids are removed", () => {
		expect(expectedMove(["a", "new", "b", "c"], ["c"], 0)).toStrictEqual(["c", "a", "new", "b"]);
		expect(expectedMove(["c", "a", "new", "b"], ["a"], 3)).toStrictEqual(["c", "new", "a", "b"]);
		expect(expectedMove(["c", "new", "a", "b"], ["b", "new"], 0)).toStrictEqual(["b", "new", "c", "a"]);
	});
});

describe("typeShape", () => {
	it("collapses the top-level object to a record and keeps nested keys", () => {
		expect(
			typeShape({
				"secret-tag": {color: "red", order: 1},
				other: {color: "blue"},
			}),
		).toBe("Record<string, {color: string; order: number} | {color: string}>");
	});

	it("redacts scalars and arrays to their types", () => {
		expect(typeShape("MM/DD/YYYY")).toBe("string");
		expect(typeShape(1)).toBe("number");
		expect(typeShape(true)).toBe("boolean");
		expect(typeShape(null)).toBe("null");
		expect(typeShape(["a", "b", 3])).toBe("Array<number | string>");
		expect(typeShape([])).toBe("Array<never>");
		expect(typeShape({})).toBe("{}");
		expect(typeShape(undefined)).toBe("absent");
	});
});

type Meta = Record<string, unknown>;

/** Internal API fake whose root metadata changes when a pushed `edit` on `None` carries patches. */
function rootMetaFetch(recorded: Recorded[], metadata: Meta) {
	const state = {metadata: structuredClone(metadata)};
	const apply = (patch: {op: string; path: string[]; value?: unknown}) => {
		const parentPath = patch.path.slice(0, -1);
		const key = patch.path.at(-1) ?? "";
		const parent = parentPath.reduce<Meta>((node, part) => node[part] as Meta, state.metadata);
		if (patch.op === "remove") {
			Reflect.deleteProperty(parent, key);
		} else {
			parent[key] = patch.value;
		}
	};
	const route = (input: string | URL | Request, init: RequestInit | undefined): Response => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const body = typeof init?.body === "string" ? init.body : undefined;
		recorded.push({path: url.pathname, body});
		if (url.pathname === "/get_initialization_data") {
			const initBody = structuredClone(INIT_BODY);
			initBody.projectTreeData.rootProjectMetadata = structuredClone(state.metadata);
			return Response.json(initBody, {headers: {wfclientid: "2026-10-18 12:00:00.123456"}});
		}
		if (url.pathname === "/push_and_poll") {
			const trees = JSON.parse(new URLSearchParams(body).get("push_poll_data") ?? "[]") as {
				operations?: {
					type: string;
					data: {projectid: string; metadataPatches?: {op: string; path: string[]}[]};
				}[];
			}[];
			for (const op of trees[0]?.operations ?? []) {
				for (const patch of op.data.metadataPatches ?? []) {
					apply(patch);
				}
			}
			return Response.json({
				results: [
					{
						new_most_recent_operation_transaction_id: "1234568",
						server_run_operation_transaction_json: JSON.stringify({ops: trees[0]?.operations ?? []}),
						concurrent_remote_operation_transactions: [],
					},
				],
			});
		}
		return respond(url.pathname, 200);
	};
	return vi.fn<typeof fetch>(async (input, init) => Promise.resolve(route(input, init)));
}

/** The `operations` of the first tree of every recorded `/push_and_poll`. */
function pushedOperations(recorded: Recorded[]): unknown[] {
	return recorded
		.filter((request) => request.path === "/push_and_poll")
		.map((push) => {
			const trees = JSON.parse(new URLSearchParams(push.body).get("push_poll_data") ?? "[]") as {
				operations?: unknown[];
			}[];
			return trees[0]?.operations;
		});
}

describe("internal probe root-meta", () => {
	let tempDir: string;
	let outPath: string;
	const savedEnv = {...process.env};

	beforeEach(() => {
		vi.useFakeTimers({toFake: ["Date"]});
		vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-probe-"));
		outPath = path.join(tempDir, "probes.md");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	const ACCOUNT_META: Meta = {
		starring: {
			locations: {"loc-1": {zoomedProjectId: "abc", searchQuery: "#secret"}},
			order: ["loc-1"],
		},
		color: {tags: {"private-tag": "red"}},
		dateFormat: "MM/DD/YYYY",
		weekStartDay: 1,
		notesRootId: "def",
	};

	it("root-meta reads the account keys as redacted types and pushes nothing", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", rootMetaFetch(recorded, ACCOUNT_META));
		await Probe.run(["root-meta", "--yes-live", "--out", outPath]);
		expect(recorded.map((request) => request.path)).toStrictEqual(["/ajax_login", "/get_initialization_data"]);
		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## root-meta (2026-10-18T12:00:00.000Z)",
				"",
				"- Top-level root metadata keys: `color`, `dateFormat`, `notesRootId`, `starring`, `weekStartDay`",
				"- `starring.locations`: `Record<string, {searchQuery: string; zoomedProjectId: string}>`",
				"- `starring.order`: `Array<string>`",
				"- `color.tags`: `Record<string, string>`",
				"- `dateFormat`: `string`",
				"- `timeFormat`: `absent`",
				"- `weekStartDay`: `number`",
				"- `slash.discovered`: `absent`",
				"- `notesRootId`: `string`",
				"",
			].join("\n"),
		);
	});

	it("refuses the root-metadata write steps without --yes-account-global and makes no request", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", rootMetaFetch(recorded, ACCOUNT_META));
		for (const step of ["root-meta-set", "root-meta-unset"]) {
			await expect(Probe.run([step, "--yes-live", "--out", outPath])).rejects.toThrow(
				"Root metadata is account-global and cannot be sandboxed: pass --yes-account-global (with the user's approval) to write it",
			);
		}
		expect(recorded).toStrictEqual([]);
	});

	it("root-meta-set writes probe.x through setRootMeta and confirms it after a fresh bootstrap", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", rootMetaFetch(recorded, ACCOUNT_META));
		await Probe.run(["root-meta-set", "--yes-live", "--yes-account-global", "--out", outPath]);
		expect(pushedOperations(recorded)).toStrictEqual([
			[
				expect.objectContaining({
					type: "edit",
					data: expect.objectContaining({
						projectid: "None",
						metadataPatches: [{op: "add", path: ["probe"], value: {x: "1"}}],
					}),
				}),
			],
		]);
		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## root-meta-set (2026-10-18T12:00:00.000Z)",
				"",
				"- `probe` before: absent",
				'- Pushed: `setRootMeta(["probe", "x"], "1")`',
				'- `probe.x` after a fresh bootstrap: `"1"` (round trip CONFIRMED)',
				"- Next: reload workflowy.com once and confirm it still loads, then run `internal probe root-meta-unset --yes-live --yes-account-global`",
				"",
			].join("\n"),
		);
	});

	it("root-meta-set refuses to touch an existing probe key", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", rootMetaFetch(recorded, {...ACCOUNT_META, probe: {other: 1}}));
		await expect(
			Probe.run(["root-meta-set", "--yes-live", "--yes-account-global", "--out", outPath]),
		).rejects.toThrow("Refusing to write: root metadata already has a `probe` key");
		expect(recorded.some((request) => request.path === "/push_and_poll")).toBe(false);
	});

	it("root-meta-unset removes probe and confirms it is gone after a fresh bootstrap", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", rootMetaFetch(recorded, {...ACCOUNT_META, probe: {x: "1"}}));
		await Probe.run(["root-meta-unset", "--yes-live", "--yes-account-global", "--out", outPath]);
		expect(pushedOperations(recorded)).toStrictEqual([
			[
				expect.objectContaining({
					type: "edit",
					data: expect.objectContaining({
						projectid: "None",
						metadataPatches: [{op: "remove", path: ["probe"]}],
					}),
				}),
			],
		]);
		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## root-meta-unset (2026-10-18T12:00:00.000Z)",
				"",
				'- `probe` before: `{"x":"1"}`',
				'- Pushed: `setRootMeta(["probe"], undefined)`',
				"- `probe` after a fresh bootstrap: absent (removal CONFIRMED)",
				"",
			].join("\n"),
		);
	});

	it("root-meta-unset refuses unless probe is exactly the throwaway value", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", rootMetaFetch(recorded, {...ACCOUNT_META, probe: {x: "1", y: 2}}));
		await expect(
			Probe.run(["root-meta-unset", "--yes-live", "--yes-account-global", "--out", outPath]),
		).rejects.toThrow('Refusing to remove: root metadata `probe` is not exactly {"x":"1"}');
		expect(recorded.some((request) => request.path === "/push_and_poll")).toBe(false);
	});
});

/** Internal API fake whose init `settings` change when `/change_settings` posts a `"yes"`/`"no"` flag. */
function settingsFetch(recorded: Recorded[], settings: Meta) {
	const state = {settings: structuredClone(settings)};
	const route = (input: string | URL | Request, init: RequestInit | undefined): Response => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const body = typeof init?.body === "string" ? init.body : undefined;
		recorded.push({path: url.pathname, body});
		if (url.pathname === "/get_initialization_data") {
			const initBody = structuredClone(INIT_BODY);
			initBody.settings = structuredClone(state.settings);
			return Response.json(initBody, {headers: {wfclientid: "2026-10-18 12:00:00.123456"}});
		}
		if (url.pathname === "/change_settings") {
			const form = new URLSearchParams(body);
			state.settings.show_completed = form.get("show_completed") === "yes";
			return Response.json({success: true});
		}
		return respond(url.pathname, 200);
	};
	return vi.fn<typeof fetch>(async (input, init) => Promise.resolve(route(input, init)));
}

describe("internal probe settings", () => {
	let tempDir: string;
	let outPath: string;
	const savedEnv = {...process.env};

	beforeEach(() => {
		vi.useFakeTimers({toFake: ["Date"]});
		vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-probe-"));
		outPath = path.join(tempDir, "probes.md");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	/** The `show_completed` values posted to `/change_settings`, in order. */
	function postedShowCompleted(recorded: Recorded[]): (string | null)[] {
		return recorded
			.filter((request) => request.path === "/change_settings")
			.map((request) => new URLSearchParams(request.body).get("show_completed"));
	}

	it("refuses without --yes-account-global and makes no request", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", settingsFetch(recorded, {show_completed: true}));
		await expect(Probe.run(["settings", "--yes-live", "--out", outPath])).rejects.toThrow(
			"Account settings are account-global and cannot be sandboxed: pass --yes-account-global (with the user's approval) to write them",
		);
		expect(recorded).toStrictEqual([]);
	});

	it("sets show_completed to its current value, flips it, restores it, and reads each back", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", settingsFetch(recorded, {show_completed: true}));
		await Probe.run(["settings", "--yes-live", "--yes-account-global", "--out", outPath]);
		expect(postedShowCompleted(recorded)).toStrictEqual(["yes", "no", "yes"]);
		expect(
			recorded
				.filter((request) => request.path === "/change_settings")
				.map((request) => new URLSearchParams(request.body).get("clientId")),
		).toStrictEqual(["2026-10-18 12:00:00.123456", "2026-10-18 12:00:00.123456", "2026-10-18 12:00:00.123456"]);
		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## settings (2026-10-18T12:00:00.000Z)",
				"",
				"- `show_completed` before: `true` (`boolean`)",
				'- Same value: posted `show_completed=yes`: HTTP 200, body `{"success":true}`; read back `true` (MATCH)',
				'- Flip: posted `show_completed=no`: HTTP 200, body `{"success":true}`; read back `false` (MATCH)',
				'- Restore: posted `show_completed=yes`: HTTP 200, body `{"success":true}`; read back `true` (MATCH)',
				"- Next: reload workflowy.com and confirm completed items show as before",
				"",
			].join("\n"),
		);
	});

	it("restores a false show_completed after flipping it to true", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", settingsFetch(recorded, {show_completed: false}));
		await Probe.run(["settings", "--yes-live", "--yes-account-global", "--out", outPath]);
		expect(postedShowCompleted(recorded)).toStrictEqual(["no", "yes", "no"]);
	});

	it("refuses to write when show_completed is not a boolean", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", settingsFetch(recorded, {}));
		await expect(Probe.run(["settings", "--yes-live", "--yes-account-global", "--out", outPath])).rejects.toThrow(
			"Refusing to write: init settings.show_completed is absent, not a boolean",
		);
		expect(postedShowCompleted(recorded)).toStrictEqual([]);
	});
});

describe("internal probe calendar-ids", () => {
	let tempDir: string;
	let outPath: string;
	const savedEnv = {...process.env};

	beforeEach(() => {
		vi.useFakeTimers({toFake: ["Date"]});
		vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-probe-"));
		outPath = path.join(tempDir, "probes.md");
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		process.env.WORKFLOWY_SESSION_FILE = path.join(tempDir, "workflowy-session");
		process.env.WORKFLOWY_DB_PATH = path.join(tempDir, "cache.sqlite");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	const OTHER_ID = "00000000-0000-4000-8000-00000000000";

	function seedCalendar(): void {
		const rows: [string, "day" | "month" | "year", number][] = [
			[calendarNodeId("k", "day", 20_261_013), "day", 20_261_013],
			[calendarNodeId("k", "day", 20_261_012), "day", 20_261_012],
			[`${OTHER_ID}1`, "day", 20_261_009],
			[calendarNodeId("k", "day", 20_261_008), "day", 20_261_008],
			[`${OTHER_ID}2`, "day", 20_261_007],
			[calendarNodeId("k", "day", 20_261_001), "day", 20_261_001],
			[calendarNodeId("k", "month", 20_261_000), "month", 20_261_000],
			[`${OTHER_ID}3`, "year", 20_260_000],
		];
		storeInternalMetadata(
			createDatabase(),
			new Map<string, Record<string, unknown>>([
				...rows.map(([nodeId, level, dateId]): [string, Record<string, unknown>] => [
					nodeId,
					{calendar: {level, value: "x", dateId, timestamp: 0}},
				]),
				[`${OTHER_ID}4`, {layoutMode: "board"}],
			]),
		);
	}

	function userDataFetch(recorded: Recorded[], user: Record<string, unknown>) {
		return vi.fn<typeof fetch>(async (input, init) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			recorded.push({path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined});
			if (url.pathname === "/get_initialization_data") {
				return Promise.resolve(
					Response.json({projectTreeData: INIT_BODY.projectTreeData}, {headers: {wfclientid: "c"}}),
				);
			}
			if (url.pathname === "/get_user_data/") {
				return Promise.resolve(Response.json({user, settings: {}, globals: [], rootProjectMetadata: {}}));
			}
			return Promise.resolve(respond(url.pathname, 200));
		});
	}

	it("compares the 5 most recent cached day ids, and every calendar level, with uuidv5 of entropyKey, read only", async () => {
		seedCalendar();
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", userDataFetch(recorded, {id: 42, entropyKey: "k"}));
		await Probe.run(["calendar-ids", "--yes-live", "--out", outPath]);
		expect(recorded.map((request) => request.path)).toStrictEqual([
			"/ajax_login",
			"/get_initialization_data",
			"/get_user_data/",
		]);
		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## calendar-ids (2026-10-18T12:00:00.000Z)",
				"",
				"- `entropyKey`: present in `/get_user_data/` `user` (1 chars, value not recorded)",
				"- Formula: ``uuidv5(`${entropyKey}-calendar-${level}-${dateId}`, 3e19dffe-1c3b-4d76-8e57-0de20e69bdae)``",
				"- Sample: the 5 most recent cached day nodes by `dateId` (`calendar_metadata`, read only)",
				"  - `20261013`: MATCH",
				"  - `20261012`: MATCH",
				"  - `20261009`: MISMATCH",
				"  - `20261008`: MATCH",
				"  - `20261007`: MISMATCH",
				"- Sample result: 3 of 5 match",
				"- All cached calendar nodes: day 4 of 6, month 1 of 1, year 0 of 1 match",
				"",
			].join("\n"),
		);
	});

	it("reports a missing entropyKey without reading the cache", async () => {
		const recorded: Recorded[] = [];
		vi.stubGlobal("fetch", userDataFetch(recorded, {id: 42}));
		await Probe.run(["calendar-ids", "--yes-live", "--out", outPath]);
		expect(fs.readFileSync(outPath, "utf8")).toBe(
			[
				"",
				"## calendar-ids (2026-10-18T12:00:00.000Z)",
				"",
				"- `entropyKey`: ABSENT from `/get_user_data/` `user`; upstream then falls back to random ids (TD9 must name-match)",
				"",
			].join("\n"),
		);
	});
});
