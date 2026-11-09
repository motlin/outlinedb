import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {Hono} from "hono";
import type {CacheService} from "@outlinedb/shared/cache";
import {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {fileSessionStore} from "@outlinedb/shared/node";
import type {AppEnv, ServerContext} from "../src/server/context.js";
import {createServerContext} from "../src/server/node-context.js";
import {internalApiRequired} from "../src/server/internal-api.js";

vi.mock("../src/server/db.js", () => ({getDatabase: () => ({})}));

afterEach(() => {
	vi.unstubAllEnvs();
});

const NO_SESSION_FILE = path.join(os.tmpdir(), "wf-no-session-file-for-tests");
const tempDirs: string[] = [];

function stubAuthEnv(username: string, password: string, sessionCookie?: string) {
	vi.stubEnv("WORKFLOWY_USERNAME", username);
	vi.stubEnv("WORKFLOWY_PASSWORD", password);
	if (sessionCookie === undefined) {
		vi.stubEnv("OUTLINEDB_SESSION_FILE", NO_SESSION_FILE);
		return;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-session-"));
	tempDirs.push(dir);
	const file = path.join(dir, "workflowy-session");
	fs.writeFileSync(file, sessionCookie);
	vi.stubEnv("OUTLINEDB_SESSION_FILE", file);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, {recursive: true, force: true});
	}
});

describe("createServerContext internalAuth", () => {
	it("reads WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD", () => {
		stubAuthEnv("alice@example.com", "pw");
		expect(createServerContext().internalAuth?.credentials).toStrictEqual({
			username: "alice@example.com",
			password: "pw",
		});
	});

	it("is configured by a saved session cookie without credentials", () => {
		stubAuthEnv("", "", "sessionid=saved");
		const auth = createServerContext().internalAuth;
		expect(auth?.credentials).toBeUndefined();
		expect(auth?.sessionStore.read()).toBe("sessionid=saved");
	});

	it("is undefined when the password is missing and no cookie is saved", () => {
		stubAuthEnv("alice@example.com", "");
		expect(createServerContext().internalAuth).toBeUndefined();
	});

	it("is undefined when the username is missing and no cookie is saved", () => {
		stubAuthEnv("", "pw");
		expect(createServerContext().internalAuth).toBeUndefined();
	});
});

describe("createServerContext internalAdapter", () => {
	it("builds one adapter lazily and reuses it when credentials are configured", () => {
		stubAuthEnv("alice@example.com", "pw");
		const ctx = createServerContext();

		const adapter = ctx.internalAdapter?.();

		expect(adapter).toBeInstanceOf(WorkflowyInternalAdapter);
		expect(ctx.internalAdapter?.()).toBe(adapter);
	});

	it("builds an adapter from a saved session cookie alone", () => {
		stubAuthEnv("", "", "sessionid=saved");
		expect(createServerContext().internalAdapter?.()).toBeInstanceOf(WorkflowyInternalAdapter);
	});

	it("is undefined when neither credentials nor a cookie are configured", () => {
		stubAuthEnv("", "");
		expect(createServerContext().internalAdapter?.()).toBeUndefined();
	});
});

function makeApp(internalAuth: ServerContext["internalAuth"]) {
	const ctx = {db: {}, cacheService: {} as CacheService, internalAuth} as ServerContext;
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("ctx", ctx);
		await next();
	});
	app.get("/dummy", internalApiRequired, (c) => c.json({ok: true}));
	return app;
}

describe("internalApiRequired", () => {
	it("answers 503 when neither internal credentials nor a session cookie are configured", async () => {
		const res = await makeApp(undefined).fetch(new Request("http://x/dummy"));
		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toStrictEqual({
			error: "Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')",
		});
	});

	it("passes through when internal auth is configured", async () => {
		const res = await makeApp({sessionStore: fileSessionStore(NO_SESSION_FILE)}).fetch(
			new Request("http://x/dummy"),
		);
		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toStrictEqual({ok: true});
	});
});

describe("createServerContext calendarEnsureEnabled", () => {
	it("reads CALENDAR_ENSURE_ENABLED, on unless set to false", () => {
		const read = (value: string | undefined) => {
			vi.stubEnv("CALENDAR_ENSURE_ENABLED", value);
			return createServerContext().calendarEnsureEnabled;
		};

		expect([read(undefined), read("true"), read("false"), read("")]).toStrictEqual([true, true, false, true]);
	});
});

describe("createServerContext calendarLayoutEnabled", () => {
	it("reads CALENDAR_LAYOUT_ENABLED, on unless set to false", () => {
		const read = (value: string | undefined) => {
			vi.stubEnv("CALENDAR_LAYOUT_ENABLED", value);
			return createServerContext().calendarLayoutEnabled;
		};

		expect([read(undefined), read("true"), read("false"), read("")]).toStrictEqual([true, true, false, true]);
	});
});
