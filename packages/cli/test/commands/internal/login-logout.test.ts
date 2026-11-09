import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Login from "../../../src/commands/internal/login.js";
import Logout from "../../../src/commands/internal/logout.js";

const COOKIE_VALUE = "secret-cookie-value";

describe("internal login and logout", () => {
	let tempDir: string;
	let sessionFile: string;
	let logged: string[];
	const savedEnv = {...process.env};

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-login-"));
		sessionFile = path.join(tempDir, "workflowy-session");
		process.env.OUTLINEDB_SESSION_FILE = sessionFile;
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		process.env.WORKFLOWY_PASSWORD = "hunter2";
		logged = [];
		vi.spyOn(console, "log").mockImplementation((message: string) => {
			logged.push(message);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		process.env = {...savedEnv};
		fs.rmSync(tempDir, {recursive: true, force: true});
	});

	it("login posts the credentials once and writes the cookie file with mode 0600 without printing it", async () => {
		const paths: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input) => {
				paths.push(new URL(input instanceof Request ? input.url : input).pathname);
				return Promise.resolve(
					new Response("", {status: 200, headers: {"set-cookie": `sessionid=${COOKIE_VALUE}; Path=/`}}),
				);
			}),
		);

		await Login.run([]);

		expect(paths).toStrictEqual(["/ajax_login"]);
		expect(fs.readFileSync(sessionFile, "utf8")).toBe(`sessionid=${COOKIE_VALUE}\n`);
		expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
		expect(logged).toStrictEqual([`Saved Workflowy session cookie to ${sessionFile}`]);
	});

	it("login refuses without credentials", async () => {
		delete process.env.WORKFLOWY_PASSWORD;
		await expect(Login.run([])).rejects.toThrow(
			"WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD must be set in the environment (e.g. from .envrc)",
		);
		expect(fs.existsSync(sessionFile)).toBe(false);
	});

	it("login examples run the command directly without a secrets tool", () => {
		expect(Login.examples).toStrictEqual(["<%= config.bin %> internal login"]);
	});

	it("logout deletes the cookie file", async () => {
		fs.writeFileSync(sessionFile, `sessionid=${COOKIE_VALUE}\n`);

		await Logout.run([]);

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(logged).toStrictEqual([`Removed Workflowy session cookie ${sessionFile}`]);
	});

	it("logout reports when there is no cookie file", async () => {
		await Logout.run([]);

		expect(logged).toStrictEqual([`No Workflowy session cookie at ${sessionFile}`]);
	});
});
