import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Login from "../../../src/commands/internal/login.js";
import Logout from "../../../src/commands/internal/logout.js";
import {ask} from "../../../src/services/prompt.js";

vi.mock("../../../src/services/prompt.js", () => (
{
	ask: vi.fn<(question: string, masked: boolean) => Promise<string>>(),
}));

const COOKIE_VALUE = "secret-cookie-value";

describe("internal login and logout", () =>
{
	let tempDir: string;
	let sessionFile: string;
	let logged: string[];
	const savedEnv =
	{
		...process.env,
	};

	beforeEach(() =>
	{
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "outlinedb-login-"));
		sessionFile = path.join(tempDir, "workflowy-session");
		process.env.OUTLINEDB_SESSION_FILE = sessionFile;
		process.env.WORKFLOWY_USERNAME = "alice@example.com";
		logged = [];
		vi.spyOn(console, "log").mockImplementation((message: string) =>
		{
			logged.push(message);
		});
	});

	afterEach(() =>
	{
		vi.resetAllMocks();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		process.env =
		{
			...savedEnv,
		};
		fs.rmSync(
			tempDir,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("login answers each step of the login form, saves the verified cookie jar with mode 0600, and keeps no answer", async () =>
	{
		const requests: string[] = [];
		vi.mocked(ask).mockImplementation(async (question, masked) =>
			Promise.resolve(question === "Password: " && masked ? "hunter2" : "123456"),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) =>
			{
				const url = new URL(input instanceof Request ? input.url : input);
				const method = init?.method ?? "GET";
				const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
				requests.push(
					`${method} ${url.pathname} [${[...form.keys()].join(", ")}] ${new Headers(init?.headers).get("cookie") ?? ""}`,
				);
				const page = (html: string, headers: Record<string, string> = {}): Response =>
					new Response(
						html,
						{
							status: 200,
							headers:
							{
								"content-type": "text/html",
								...headers,
							},
						},
					);
				const redirect = (location: string, cookie: string): Response =>
					new Response(
						null,
						{
							status: 302,
							headers:
							{
								location,
								"set-cookie": cookie,
							},
						},
					);
				const route = `${method} ${url.pathname}`;
				if (route === "GET /login/")
				{
					return page(
						'<form method="POST"><input type="hidden" name="csrfmiddlewaretoken" value="t1"><input type="email" name="email"></form>',
						{
							"set-cookie": "csrftoken=t1; Path=/",
						},
					);
				}
				if (route === "POST /login/" && !form.has("password"))
				{
					return page(
						'<form method="POST"><input type="hidden" name="csrfmiddlewaretoken" value="t1"><input type="hidden" name="email"><label for="p">Password</label><input type="password" name="password" id="p"></form>',
					);
				}
				if (route === "POST /login/")
				{
					return redirect("/login-mfa/", "mfa=m1; Path=/");
				}
				if (route === "GET /login-mfa/")
				{
					return page(
						'<form method="POST" action="/login-mfa/"><input type="hidden" name="csrfmiddlewaretoken" value="t2"><label for="c">Authenticator code</label><input name="code" id="c"></form>',
					);
				}
				if (route === "POST /login-mfa/")
				{
					return redirect("/", `sessionid=${COOKIE_VALUE}; Path=/`);
				}
				if (route === "GET /")
				{
					return page("<html>home</html>");
				}
				return Promise.resolve(
					new Response(
						"{}",
						{
							status: 200,
						},
					),
				);
			}),
		);

		await Login.run([]);

		const jar = `csrftoken=t1; mfa=m1; sessionid=${COOKIE_VALUE}`;
		expect(
			{
				asked: vi.mocked(ask).mock.calls,
				requests,
				file: fs.readFileSync(sessionFile, "utf8"),
				mode: fs.statSync(sessionFile).mode & 0o777,
				logged,
			},
		).toStrictEqual(
			{
				asked: [
					["Password: ", true],
					["Authenticator code: ", false],
				],
				requests: [
					"GET /login/ [] ",
					"POST /login/ [csrfmiddlewaretoken, email] csrftoken=t1",
					"POST /login/ [csrfmiddlewaretoken, email, password] csrftoken=t1",
					"GET /login-mfa/ [] csrftoken=t1; mfa=m1",
					"POST /login-mfa/ [csrfmiddlewaretoken, code] csrftoken=t1; mfa=m1",
					`GET / [] ${jar}`,
					`GET /get_initialization_data [] ${jar}`,
				],
				file: `${jar}\n`,
				mode: 0o600,
				logged: [`Saved Workflowy session cookie to ${sessionFile}`],
			},
		);
	});

	it("login stops at a captcha without asking anything or saving a cookie", async () =>
	{
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async () =>
				Promise.resolve(
					new Response('<form method="POST"><input name="email"><div class="g-recaptcha"></div></form>'),
				),
			),
		);

		await expect(Login.run([])).rejects.toThrow(
			"workflowy.com asked for a captcha, which this login cannot answer; log in at https://workflowy.com in a browser, then try again later",
		);
		expect(
			{
				asked: vi.mocked(ask).mock.calls,
				saved: fs.existsSync(sessionFile),
			},
		).toStrictEqual(
			{
				asked: [],
				saved: false,
			},
		);
	});

	it("login refuses without an email", async () =>
	{
		delete process.env.WORKFLOWY_USERNAME;
		await expect(Login.run([])).rejects.toThrow(
			"WORKFLOWY_USERNAME must be set to the account's email (e.g. from .envrc)",
		);
		expect(fs.existsSync(sessionFile)).toBe(false);
	});

	it("login examples run the command directly without a secrets tool", () =>
	{
		expect(Login.examples).toStrictEqual(["<%= config.bin %> internal login"]);
	});

	it("logout deletes the cookie file", async () =>
	{
		fs.writeFileSync(sessionFile, `sessionid=${COOKIE_VALUE}\n`);

		await Logout.run([]);

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(logged).toStrictEqual([`Removed Workflowy session cookie ${sessionFile}`]);
	});

	it("logout reports when there is no cookie file", async () =>
	{
		await Logout.run([]);

		expect(logged).toStrictEqual([`No Workflowy session cookie at ${sessionFile}`]);
	});
});
