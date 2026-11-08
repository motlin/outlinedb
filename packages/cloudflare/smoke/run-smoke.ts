// Browser smoke against a local `vp dev -c vite.worker.config.ts` (Cloudflare Vite plugin) with a fake upstream. Outside verify: it needs a Chromium install, spawns workerd,
// and reaches Cloudflare's Turnstile with its published always-pass test keys.
import {spawn, spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {existsSync, mkdtempSync, readdirSync, rmSync} from "node:fs";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {chromium} from "playwright-core";
import type {Browser, BrowserContext, Page} from "playwright-core";
import {startFakeUpstream} from "./fake-upstream.ts";

const webDir = new URL("../../web", import.meta.url).pathname;
const port = process.env.SMOKE_PORT ?? "8798";
const base = `http://localhost:${port}`;
const editedName = "Smoke home edited";
const cloudflareDir = new URL("..", import.meta.url).pathname;

function chromiumPath(): string | undefined {
	const override = process.env.CHROMIUM_PATH;
	if (override !== undefined) {
		return override;
	}
	const cache = join(homedir(), "Library/Caches/ms-playwright");
	const dirs = existsSync(cache)
		? readdirSync(cache)
				.filter((d) => /^chromium-\d+$/u.test(d))
				.toSorted()
				.toReversed()
		: [];
	for (const dir of dirs) {
		for (const rel of [
			"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
			"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
		]) {
			if (existsSync(join(cache, dir, rel))) {
				return join(cache, dir, rel);
			}
		}
	}
	return undefined;
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (await check()) {
				return;
			}
		} catch {
			// keep polling
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((r) => {
			setTimeout(r, 250);
		});
	}
}

const preferences = {
	dateFormat: null,
	timeFormat: null,
	weekStartDay: null,
	slashDiscovered: false,
	notesRootId: null,
	weeklyReportOn: false,
	showCompleted: false,
	showKeyboardShortcuts: false,
	sameColorForLinks: false,
	displayImagePreviewsAsThumbnails: false,
	ignoreYoutube: false,
	ignoreYtShort: false,
	ignoreTwitter: false,
	ignoreLoom: false,
	unsubscribeFromSummaryEmails: false,
	unsubscribeFromCommentsEmails: false,
	theme: null,
	account: null,
};

const upstream = await startFakeUpstream();
const persist = mkdtempSync(join(tmpdir(), "wf-cf-smoke-"));
const migrate = spawnSync(
	"vp",
	["exec", "wrangler", "d1", "migrations", "apply", "AUTH_DB", "--local", "--persist-to", persist],
	{cwd: cloudflareDir, stdio: "inherit"},
);
if (migrate.status !== 0) {
	throw new Error("applying the AUTH_DB migrations failed");
}
/**
 * Auth for the signup path. A plain record, since the generated Worker types pin these names in `process.env` to their
 * production values.
 */
const authVars: Record<string, string> = {
	APP_ORIGIN: base,
	BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
	EMAIL_PROVIDER: "log",
	SIGNUP_MODE: "open",
	// Cloudflare's published always-pass Turnstile test keys.
	TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
	TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
};
const wrangler = spawn("vp", ["dev", "-c", "vite.worker.config.ts", "--port", port, "--strictPort"], {
	cwd: webDir,
	env: {
		...process.env,
		WORKER_PERSIST_DIR: persist,
		ACCESS_DEV_IDENTITY: "dev",
		WORKFLOWY_API_URL: upstream.url,
		WORKFLOWY_API_KEY: "fake-smoke-key",
		WORKFLOWY_ENV_OWNERS: "dev",
		...authVars,
	},
	stdio: ["ignore", "pipe", "inherit"],
	// Own process group, so the kill below also reaches the node and workerd children of vp.
	detached: true,
});
/** The dev server's output, echoed and kept, since the log sender prints each email (and its verify link) there. */
let devOutput = "";
wrangler.stdout.on("data", (chunk: Buffer) => {
	process.stdout.write(chunk);
	devOutput += chunk.toString();
});

/** These three routes read workflowy.com's session-based internal API, which the fake upstream does not model and the smoke must never reach. */
async function stubInternalApi(target: Page | BrowserContext): Promise<void> {
	await target.route("**/api/v1/home", async (route) => route.fulfill({json: {layoutMode: "bullets"}}));
	await target.route("**/api/v1/tags", async (route) => route.fulfill({json: {colors: {}}}));
	await target.route("**/api/v1/preferences", async (route) => route.fulfill({json: preferences}));
}

/** Signs up a new user in a fresh context, opens the verify link the log sender printed, and lands on the outline. */
async function signupVerifyAndLand(active: Browser): Promise<void> {
	const context = await active.newContext();
	await stubInternalApi(context);
	const signup = await context.newPage();
	page = signup;
	const email = `smoke-${Date.now()}@example.com`;
	await signup.goto(`${base}/signup`);
	await signup.locator("input[name=email]").fill(email);
	await signup.locator("input[name=password]").fill("smoke password 1");
	await waitFor(
		async () => (await signup.locator("input[name=cf-turnstile-response]").inputValue()) !== "",
		"the Turnstile test token",
	);
	await signup.locator("form button[type=submit]").click();
	await signup.waitForURL("**/verify-email?**", {timeout: 15_000});
	let verifyUrl: string | undefined;
	await waitFor(() => {
		// The log sender prints the text body as a quoted string, so the link ends at a quote or its escaped newline.
		verifyUrl = new RegExp(`${base}/api/auth/verify-email\\?[^\\s'"\\\\]+`, "u").exec(devOutput)?.[0];
		return verifyUrl !== undefined;
	}, "the verification email in the log sender's output");
	await signup.goto(verifyUrl ?? "");
	await signup.waitForURL((url) => url.pathname === "/", {timeout: 15_000});
	await signup.locator(".outline-container").waitFor({timeout: 30_000});
	const session: unknown = await (await signup.request.get(`${base}/api/auth/get-session`)).json();
	const signedIn =
		typeof session === "object" &&
		session !== null &&
		"user" in session &&
		typeof session.user === "object" &&
		session.user !== null &&
		"email" in session.user &&
		session.user.email === email;
	if (!signedIn || new URL(signup.url()).pathname !== "/") {
		throw new Error(`expected ${email} signed in on the outline, got ${signup.url()}`);
	}
	await context.close();
}

let browser: Browser | undefined;
let page: Page | undefined;
let failure: unknown;
try {
	await waitFor(async () => (await fetch(`${base}/health`)).ok, "the worker dev server");
	await fetch(`${base}/api/admin/sync`, {method: "POST"});
	await waitFor(async () => {
		const status: unknown = await (await fetch(`${base}/api/admin/status`)).json();
		return (
			typeof status === "object" &&
			status !== null &&
			"nodeCount" in status &&
			status.nodeCount === upstream.nodes.size
		);
	}, "the initial sync");

	browser = await chromium.launch({executablePath: chromiumPath()});
	page = await browser.newPage();
	await stubInternalApi(page);
	await page.goto(base);
	const target = page.locator(".name", {hasText: "Smoke home"}).last();
	await target.waitFor({timeout: 30_000});
	await target.click();
	await page.keyboard.press("End");
	await page.keyboard.type(" edited");
	await page.keyboard.press("Escape");
	await page.getByText(editedName).first().waitFor({timeout: 15_000});
	await waitFor(
		() => [...upstream.nodes.values()].some((n) => n.name === editedName),
		"the edit to reach the fake upstream",
	);
	console.log("smoke ok: home page loaded, edit shown and written through to the fake upstream");
	await signupVerifyAndLand(browser);
	console.log("smoke ok: signed up, verified through the log sender and landed on the outline");
} catch (error) {
	failure = error;
	console.error(upstream.requests.slice(-10), page?.url());
	const shot = process.env.SMOKE_SHOT;
	if (shot !== undefined) {
		await page?.screenshot({path: shot});
	}
} finally {
	await browser?.close();
	process.kill(-(wrangler.pid ?? 0), "SIGTERM");
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 5000);
		wrangler.on("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	await upstream.close();
	rmSync(persist, {recursive: true, force: true});
}
if (failure !== undefined) {
	console.error(failure);
	process.exit(1);
}
