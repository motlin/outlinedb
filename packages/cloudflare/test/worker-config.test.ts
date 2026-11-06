import {describe, expect, it} from "vite-plus/test";
import {readWorkerConfig, readWorkerInternalAuth} from "../src/worker-config";
import {kvSessionStore} from "../src/session-store";
import type {KvLike} from "../src/session-store";

function fakeKv(): KvLike & {data: Map<string, string>} {
	const data = new Map<string, string>();
	return {
		data,
		get: (key) => data.get(key),
		put(key, value) {
			data.set(key, value);
		},
		delete(key) {
			return data.delete(key);
		},
	};
}

describe("readWorkerConfig", () => {
	it("leaves writes unavailable and embeddings off when no secrets are bound", () => {
		expect(readWorkerConfig({})).toStrictEqual({
			apiKey: undefined,
			apiUrl: undefined,
			accountEmail: "",
			sqlQueryLogging: false,
			calendarEnsureEnabled: true,
			calendarLayoutEnabled: true,
			features: {embeddings: false, treeSnapshot: true},
		});
	});

	it("reads the API key, the upstream URL and the account email from bindings", () => {
		expect(
			readWorkerConfig({
				WORKFLOWY_API_KEY: "k",
				WORKFLOWY_API_URL: "http://upstream.test",
				WORKFLOWY_USERNAME: "a@example.com",
			}),
		).toMatchObject({apiKey: "k", apiUrl: "http://upstream.test", accountEmail: "a@example.com"});
	});

	it("turns the tree snapshot off when TREE_SNAPSHOT is false", () => {
		expect(readWorkerConfig({TREE_SNAPSHOT: "false"}).features).toStrictEqual({
			embeddings: false,
			treeSnapshot: false,
		});
	});

	it("turns embeddings on only when both the AI and the RELATED_INDEX bindings exist", () => {
		const binding = {};
		expect(readWorkerConfig({AI: binding, RELATED_INDEX: binding}).features.embeddings).toBe(true);
		expect(readWorkerConfig({AI: binding}).features.embeddings).toBe(false);
		expect(readWorkerConfig({RELATED_INDEX: binding}).features.embeddings).toBe(false);
	});

	it("treats empty bindings as unset", () => {
		expect(readWorkerConfig({WORKFLOWY_API_KEY: "", WORKFLOWY_API_URL: ""})).toMatchObject({
			apiKey: undefined,
			apiUrl: undefined,
		});
	});
});

describe("kvSessionStore", () => {
	it("seeds from the binding on first use and then prefers the stored cookie", () => {
		const kv = fakeKv();
		const store = kvSessionStore(kv, "sessionid=seed");
		expect(store.read()).toBe("sessionid=seed");
		store.write("sessionid=rotated");
		expect(kvSessionStore(kv, "sessionid=seed").read()).toBe("sessionid=rotated");
	});

	it("stays cleared after clear() rather than reseeding", () => {
		const kv = fakeKv();
		const store = kvSessionStore(kv, "sessionid=seed");
		store.clear();
		expect(kvSessionStore(kv, "sessionid=seed").read()).toBeUndefined();
	});

	it("reads undefined with no seed and nothing stored", () => {
		expect(kvSessionStore(fakeKv(), undefined).read()).toBeUndefined();
	});
});

describe("readWorkerInternalAuth", () => {
	it("is undefined with neither credentials nor a cookie", () => {
		expect(readWorkerInternalAuth({}, kvSessionStore(fakeKv(), undefined))).toBeUndefined();
	});

	it("carries credentials when both username and password are bound", () => {
		const store = kvSessionStore(fakeKv(), undefined);
		expect(readWorkerInternalAuth({WORKFLOWY_USERNAME: "u", WORKFLOWY_PASSWORD: "p"}, store)).toStrictEqual({
			credentials: {username: "u", password: "p"},
			sessionStore: store,
		});
	});

	it("carries only the session store when a cookie is seeded", () => {
		const store = kvSessionStore(fakeKv(), "sessionid=seed");
		expect(readWorkerInternalAuth({WORKFLOWY_SESSION_COOKIE: "sessionid=seed"}, store)).toStrictEqual({
			sessionStore: store,
		});
	});
});
