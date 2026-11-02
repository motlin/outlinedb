import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import {DEFAULT_SESSION_FILE, fileSessionStore, readInternalAuth} from "../src/node/session-store.js";
import type {SessionCookieStore} from "../src/api/workflowy-internal-client.js";
import {createFakeInternalApi, FAKE_SESSION_ID, json} from "./helpers/fake-internal-api.js";

const BASE_URL = "https://workflowy.test";
const CREDENTIALS =
{
	username: "alice@example.com",
	password: "hunter2",
};
const SAVED_COOKIE = "sessionid=saved-session-0";

function memoryStore(initial?: string): SessionCookieStore &
{
	writes: string[];
}
{
	let value = initial;
	const writes: string[] = [];
	return {
		writes,
		read: () => value,
		write: (cookie) =>
		{
			value = cookie;
			writes.push(cookie);
		},
		clear: () =>
		{
			value = undefined;
		},
	};
}

const tempDirs: string[] = [];
function tempFile(): string
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-session-"));
	tempDirs.push(dir);
	return path.join(dir, "workflowy-session");
}

afterEach(() =>
{
	for (const dir of tempDirs.splice(0))
	{
		fs.rmSync(
			dir,
			{
				recursive: true,
				force: true,
			},
		);
	}
});

describe("WorkflowyInternalClient with a session store", () =>
{
	it("reuses a stored cookie without logging in", async () =>
	{
		const api = createFakeInternalApi();
		const store = memoryStore(SAVED_COOKIE);
		const client = new WorkflowyInternalClient(
			{
				sessionStore: store,
				fetch: api.fetch,
				baseUrl: BASE_URL,
			},
		);

		await client.bootstrap();

		expect(api.requests.map((r) => [r.method, r.path, r.headers.cookie])).toStrictEqual([
			["GET", "/get_initialization_data", SAVED_COOKIE],
		]);
		expect(store.writes).toStrictEqual([]);
	});

	it("logs in once with the password on an expired cookie and rewrites the store", async () =>
	{
		const api = createFakeInternalApi();
		api.respondOnce(
			"/get_initialization_data",
			() =>
				new Response(
					"",
					{
						status: 302,
						headers:
						{
							location: "/login/",
						},
					},
				),
		);
		const store = memoryStore(SAVED_COOKIE);
		const client = new WorkflowyInternalClient(
			{
				credentials: CREDENTIALS,
				sessionStore: store,
				fetch: api.fetch,
				baseUrl: BASE_URL,
			},
		);

		await client.bootstrap();

		expect(api.requests.map((r) => [r.method, r.path, r.headers.cookie])).toStrictEqual([
			["GET", "/get_initialization_data", SAVED_COOKIE],
			["POST", "/ajax_login", undefined],
			["GET", "/get_initialization_data", `sessionid=${FAKE_SESSION_ID}`],
		]);
		expect(store.writes).toStrictEqual([`sessionid=${FAKE_SESSION_ID}`]);
	});

	it("re-logs in for getTreeSnapshot too when the stored cookie is logged out", async () =>
	{
		const api = createFakeInternalApi();
		api.respondOnce("/get_tree_data/", () =>
			json(
				{
					logged_out: true,
				},
			),
		);
		const store = memoryStore(SAVED_COOKIE);
		const client = new WorkflowyInternalClient(
			{
				credentials: CREDENTIALS,
				sessionStore: store,
				fetch: api.fetch,
				baseUrl: BASE_URL,
			},
		);

		const result = await client.getTreeSnapshot();

		expect(result).toStrictEqual(
			{
				items: [],
				txId: "9999",
				expandedKeys: [],
			},
		);
		expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
			["GET", "/get_tree_data/"],
			["POST", "/ajax_login"],
			["GET", "/get_tree_data/"],
		]);
		expect(store.writes).toStrictEqual([`sessionid=${FAKE_SESSION_ID}`]);
	});

	it("fails clearly when the cookie expired and no credentials are available", async () =>
	{
		const api = createFakeInternalApi();
		api.respond("/get_initialization_data", () =>
			json(
				{
					logged_out: true,
				},
			),
		);
		const client = new WorkflowyInternalClient(
			{
				sessionStore: memoryStore(SAVED_COOKIE),
				fetch: api.fetch,
				baseUrl: BASE_URL,
			},
		);

		await expect(client.bootstrap()).rejects.toThrow(
			new Error(
				"Workflowy session cookie is missing or expired and WORKFLOWY_USERNAME/WORKFLOWY_PASSWORD are not set; set them in the environment (e.g. from .envrc), or run './bin/run.js internal login' with them set",
			),
		);
		expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([["GET", "/get_initialization_data"]]);
	});

	it("fails clearly with neither a cookie nor credentials", async () =>
	{
		const api = createFakeInternalApi();
		const client = new WorkflowyInternalClient(
			{
				sessionStore: memoryStore(),
				fetch: api.fetch,
				baseUrl: BASE_URL,
			},
		);

		await expect(client.bootstrap()).rejects.toThrow(
			new Error(
				"Workflowy session cookie is missing or expired and WORKFLOWY_USERNAME/WORKFLOWY_PASSWORD are not set; set them in the environment (e.g. from .envrc), or run './bin/run.js internal login' with them set",
			),
		);
		expect(api.requests).toStrictEqual([]);
	});
});

describe("fileSessionStore", () =>
{
	it("reads nothing when the file is missing, then round-trips a cookie with mode 0600", () =>
	{
		const file = tempFile();
		const store = fileSessionStore(file);

		expect(store.read()).toBeUndefined();
		store.write(SAVED_COOKIE);

		expect(store.read()).toBe(SAVED_COOKIE);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it("tightens an existing file to 0600 on rewrite and deletes it on clear", () =>
	{
		const file = tempFile();
		fs.writeFileSync(
			file,
			"sessionid=old\n",
			{
				mode: 0o644,
			},
		);
		const store = fileSessionStore(file);

		store.write(SAVED_COOKIE);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(store.read()).toBe(SAVED_COOKIE);

		store.clear();
		expect(fs.existsSync(file)).toBe(false);
		expect(store.read()).toBeUndefined();
	});
});

describe("readInternalAuth", () =>
{
	it("defaults the session file to .llm/workflowy-session at the repository root", () =>
	{
		expect(DEFAULT_SESSION_FILE).toBe(path.resolve(import.meta.dirname, "../../../.llm/workflowy-session"));
	});

	it("is undefined with neither credentials nor a session file", () =>
	{
		expect(
			readInternalAuth(
				{
					OUTLINEDB_SESSION_FILE: tempFile(),
				},
			),
		).toBeUndefined();
	});

	it("is configured by a session file alone", () =>
	{
		const file = tempFile();
		fs.writeFileSync(file, SAVED_COOKIE);

		const auth = readInternalAuth(
			{
				OUTLINEDB_SESSION_FILE: file,
			},
		);

		expect(auth?.credentials).toBeUndefined();
		expect(auth?.sessionStore.read()).toBe(SAVED_COOKIE);
	});

	it("is configured by credentials alone", () =>
	{
		const auth = readInternalAuth(
			{
				OUTLINEDB_SESSION_FILE: tempFile(),
				WORKFLOWY_USERNAME: CREDENTIALS.username,
				WORKFLOWY_PASSWORD: CREDENTIALS.password,
			},
		);

		expect(auth?.credentials).toStrictEqual(CREDENTIALS);
		expect(auth?.sessionStore.read()).toBeUndefined();
	});
});
