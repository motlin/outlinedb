// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	isAuthPath,
	loginUrl,
	openImportFromUrl,
	redirectToLogin,
	safeNext,
	withImportOpen,
} from "../src/client/auth/login-redirect.js";
import {readJson} from "../src/client/read-json.js";
import {RequestStatusError, toRequestStatusError} from "../src/client/request-error.js";
import {redirectOnAuthError} from "../src/client/query-retry.js";

function fakeLocation(pathname: string, search = "", hash = "")
{
	const assigned: string[] = [];
	return {
		assigned,
		location:
		{
			pathname,
			search,
			hash,
			assign: (url: string) =>
			{
				assigned.push(url);
			},
		},
	};
}

afterEach(() =>
{
	vi.restoreAllMocks();
});

describe("loginUrl", () =>
{
	it("keeps the path, query and hash as next", () =>
	{
		expect(
			loginUrl(
				{
					pathname: "/",
					search: "?q=x",
					hash: "#/abc",
				},
			),
		).toBe("/login?next=%2F%3Fq%3Dx%23%2Fabc");
	});
});

describe("opening the import dialog from the URL", () =>
{
	it("adds the parameter to a next path, then opens the dialog once and drops the parameter, keeping the zoom", () =>
	{
		let opened = 0;
		const replaced: string[] = [];
		const history =
		{
			state: null,
			replaceState: (_state: unknown, _unused: string, url?: string | URL | null) =>
			{
				replaced.push(String(url));
			},
		};
		const open = () =>
		{
			opened++;
		};
		const link = withImportOpen("/?q=x#/abc");
		openImportFromUrl(
			{
				href: `http://origin${link}`,
			},
			history,
			open,
		);
		openImportFromUrl(
			{
				href: "http://origin/#/abc",
			},
			history,
			open,
		);

		expect([link, opened, replaced]).toStrictEqual(["/?q=x&import=open#/abc", 1, ["/?q=x#/abc"]]);
	});
});

describe("safeNext", () =>
{
	it("keeps a same-origin path and refuses anything else", () =>
	{
		expect([
			safeNext("/#/abc"),
			safeNext(null),
			safeNext("https://evil.example/"),
			safeNext("//evil.example/"),
			safeNext(String.raw`/\evil.example`),
			safeNext("/login?next=%2F"),
			safeNext("/welcome?next=%2F"),
		]).toStrictEqual(["/#/abc", "/", "/", "/", "/", "/", "/"]);
	});
});

describe("isAuthPath", () =>
{
	it("matches the four auth screens and the welcome step only", () =>
	{
		expect(
			["/login", "/signup", "/verify-email", "/reset-password", "/welcome", "/", "/changes", "/login/x"].map(
				isAuthPath,
			),
		).toStrictEqual([true, true, true, true, true, false, false, false]);
	});
});

describe("redirectToLogin", () =>
{
	it("sends the user to /login with next", () =>
	{
		const {assigned, location} = fakeLocation("/changes", "", "#/n1");

		redirectToLogin(location);

		expect(assigned).toStrictEqual(["/login?next=%2Fchanges%23%2Fn1"]);
	});

	it("does nothing on an auth screen, so a 401 there never loops", () =>
	{
		const {assigned, location} = fakeLocation("/login", "?next=%2F");

		redirectToLogin(location);

		expect(assigned).toStrictEqual([]);
	});
});

describe("401 handlers", () =>
{
	function spyAssign()
	{
		const assigned: string[] = [];
		vi.spyOn(globalThis.location, "assign").mockImplementation((url: string | URL) =>
		{
			assigned.push(String(url));
		});
		return assigned;
	}

	it("readJson redirects to login on a 401", async () =>
	{
		const assigned = spyAssign();

		await readJson(
			Response.json(
				{
					error: "unauthenticated",
				},
				{
					status: 401,
				},
			),
		).catch(() => {});

		expect(assigned).toStrictEqual([loginUrl(globalThis.location)]);
	});

	it("toRequestStatusError redirects to login on a 401 and keeps the status", async () =>
	{
		const assigned = spyAssign();

		const error = await toRequestStatusError(
			"Failed",
			Response.json(
				{
					error: "unauthenticated",
				},
				{
					status: 401,
				},
			),
		);

		expect([assigned, error.status]).toStrictEqual([[loginUrl(globalThis.location)], 401]);
	});

	it("the query client redirects on a 401 RequestStatusError only", () =>
	{
		const assigned = spyAssign();

		redirectOnAuthError(new RequestStatusError(500, "boom"));
		redirectOnAuthError(new Error("plain"));
		redirectOnAuthError(new RequestStatusError(401, "unauthenticated"));

		expect(assigned).toStrictEqual([loginUrl(globalThis.location)]);
	});
});
