import {describe, expect, it} from "vite-plus/test";
import {isStoreOwner, readWorkerConfig, readWorkerInternalAuth} from "../src/worker-config";
import {kvSessionStore} from "../src/session-store";
import type {KvLike} from "../src/session-store";

function fakeKv(): KvLike &
{
	data: Map<string, string>;
}
{
	const data = new Map<string, string>();
	return {
		data,
		get: (key) => data.get(key),
		put(key, value)
		{
			data.set(key, value);
		},
		delete(key)
		{
			return data.delete(key);
		},
	};
}

describe("readWorkerConfig", () =>
{
	it("leaves writes unavailable and embeddings off when no secrets are bound", () =>
	{
		expect(readWorkerConfig({}, true)).toStrictEqual(
			{
				mode: "mirror",
				apiKey: undefined,
				apiUrl: undefined,
				accountEmail: "",
				sqlQueryLogging: false,
				calendarEnsureEnabled: true,
				calendarLayoutEnabled: true,
				features:
				{
					embeddings: false,
					treeSnapshot: false,
				},
			},
		);
	});

	it("reads the API key, the upstream URL and the account email from bindings", () =>
	{
		expect(
			readWorkerConfig(
				{
					WORKFLOWY_API_KEY: "k",
					WORKFLOWY_API_URL: "http://upstream.test",
					WORKFLOWY_USERNAME: "a@example.com",
				},
				true,
			),
		).toMatchObject(
			{
				apiKey: "k",
				apiUrl: "http://upstream.test",
				accountEmail: "a@example.com",
			},
		);
	});

	it("makes a non-owner standalone with no API key but keeps the upstream URL and features", () =>
	{
		expect(
			readWorkerConfig(
				{
					WORKFLOWY_API_KEY: "k",
					WORKFLOWY_API_URL: "http://upstream.test",
					WORKFLOWY_USERNAME: "a@example.com",
				},
				false,
			),
		).toStrictEqual(
			{
				mode: "standalone",
				apiKey: undefined,
				apiUrl: "http://upstream.test",
				accountEmail: "",
				sqlQueryLogging: false,
				calendarEnsureEnabled: true,
				calendarLayoutEnabled: true,
				features:
				{
					embeddings: false,
					treeSnapshot: false,
				},
			},
		);
	});

	it("turns the tree snapshot on only when TREE_SNAPSHOT is true", () =>
	{
		expect(
			readWorkerConfig(
				{
					TREE_SNAPSHOT: "true",
				},
				true,
			).features,
		).toStrictEqual(
			{
				embeddings: false,
				treeSnapshot: true,
			},
		);
	});

	it("turns embeddings on only when both the AI and the RELATED_INDEX bindings exist", () =>
	{
		const binding = {};
		expect(
			readWorkerConfig(
				{
					AI: binding,
					RELATED_INDEX: binding,
				},
				true,
			).features.embeddings,
		).toBe(true);
		expect(
			readWorkerConfig(
				{
					AI: binding,
				},
				true,
			).features.embeddings,
		).toBe(false);
		expect(
			readWorkerConfig(
				{
					RELATED_INDEX: binding,
				},
				true,
			).features.embeddings,
		).toBe(false);
	});

	it("treats empty bindings as unset", () =>
	{
		expect(
			readWorkerConfig(
				{
					WORKFLOWY_API_KEY: "",
					WORKFLOWY_API_URL: "",
				},
				true,
			),
		).toMatchObject(
			{
				apiKey: undefined,
				apiUrl: undefined,
			},
		);
	});
});

describe("kvSessionStore", () =>
{
	it("seeds from the binding on first use and then prefers the stored cookie", () =>
	{
		const kv = fakeKv();
		const store = kvSessionStore(kv, "sessionid=seed");
		expect(store.read()).toBe("sessionid=seed");
		store.write("sessionid=rotated");
		expect(kvSessionStore(kv, "sessionid=seed").read()).toBe("sessionid=rotated");
	});

	it("stays cleared after clear() rather than reseeding", () =>
	{
		const kv = fakeKv();
		const store = kvSessionStore(kv, "sessionid=seed");
		store.clear();
		expect(kvSessionStore(kv, "sessionid=seed").read()).toBeUndefined();
	});

	it("reads undefined with no seed and nothing stored", () =>
	{
		expect(kvSessionStore(fakeKv(), undefined).read()).toBeUndefined();
	});

	it("leaves the seed for a later store when built with seed: false", () =>
	{
		const kv = fakeKv();
		const unseeded = kvSessionStore(
			kv,
			undefined,
			{
				seed: false,
			},
		).read();
		expect([unseeded, kvSessionStore(kv, "sessionid=seed").read()]).toStrictEqual([undefined, "sessionid=seed"]);
	});
});

describe("readWorkerInternalAuth", () =>
{
	it("is undefined with neither credentials nor a cookie", () =>
	{
		expect(readWorkerInternalAuth({}, kvSessionStore(fakeKv(), undefined), true)).toBeUndefined();
	});

	it("carries credentials when both username and password are bound", () =>
	{
		const store = kvSessionStore(fakeKv(), undefined);
		expect(
			readWorkerInternalAuth(
				{
					WORKFLOWY_USERNAME: "u",
					WORKFLOWY_PASSWORD: "p",
				},
				store,
				true,
			),
		).toStrictEqual(
			{
				credentials:
				{
					username: "u",
					password: "p",
				},
				sessionStore: store,
			},
		);
	});

	it("is undefined for a non-owner even with credentials and a cookie", () =>
	{
		const store = kvSessionStore(fakeKv(), "sessionid=seed");
		expect(
			readWorkerInternalAuth(
				{
					WORKFLOWY_USERNAME: "u",
					WORKFLOWY_PASSWORD: "p",
					WORKFLOWY_SESSION_COOKIE: "sessionid=seed",
				},
				store,
				false,
			),
		).toBeUndefined();
	});

	it("carries only the session store when a cookie is seeded", () =>
	{
		const store = kvSessionStore(fakeKv(), "sessionid=seed");
		expect(
			readWorkerInternalAuth(
				{
					WORKFLOWY_SESSION_COOKIE: "sessionid=seed",
				},
				store,
				true,
			),
		).toStrictEqual(
			{
				sessionStore: store,
			},
		);
	});
});

describe("isStoreOwner", () =>
{
	it("matches the store name against OUTLINEDB_ENV_OWNERS, ignoring case and spaces", () =>
	{
		const env =
		{
			OUTLINEDB_ENV_OWNERS: "dev, Craig@Example.com",
			ALLOWED_EMAILS: "other@example.com",
		};
		expect(
			["dev", "craig@example.com", "other@example.com", "user-123", undefined].map((name) =>
				isStoreOwner(name, env),
			),
		).toStrictEqual([true, true, false, false, false]);
	});

	it("falls back to ALLOWED_EMAILS when OUTLINEDB_ENV_OWNERS is unset or empty", () =>
	{
		const allowed = "Alice@example.com, bob@example.com";
		expect(
			[
				{
					ALLOWED_EMAILS: allowed,
				},
				{
					ALLOWED_EMAILS: allowed,
					OUTLINEDB_ENV_OWNERS: "",
				},
			].map((env) => [isStoreOwner("alice@example.com", env), isStoreOwner("user-123", env)]),
		).toStrictEqual([
			[true, false],
			[true, false],
		]);
	});

	it("owns nothing when neither list is set", () =>
	{
		expect(isStoreOwner("dev", {})).toBe(false);
	});
});
