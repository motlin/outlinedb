// Browser smoke against a local `vp dev -c vite.worker.config.ts` (Cloudflare Vite plugin) with a fake upstream. Outside verify: it needs a Chromium install and spawns workerd.
import {spawn} from "node:child_process";
import {existsSync, mkdtempSync, readdirSync, rmSync} from "node:fs";
import {homedir, tmpdir} from "node:os";
import {join} from "node:path";
import {chromium} from "playwright-core";
import type {Browser, Page} from "playwright-core";
import {startFakeUpstream} from "./fake-upstream.ts";

const webDir = new URL("../../web", import.meta.url).pathname;
const port = process.env.SMOKE_PORT ?? "8798";
const base = `http://localhost:${port}`;
const editedName = "Smoke home edited";

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
const wrangler = spawn("vp", ["dev", "-c", "vite.worker.config.ts", "--port", port, "--strictPort"], {
	cwd: webDir,
	env: {
		...process.env,
		WORKER_PERSIST_DIR: persist,
		ACCESS_DEV_IDENTITY: "dev",
		WORKFLOWY_API_URL: upstream.url,
		WORKFLOWY_API_KEY: "fake-smoke-key",
		WORKFLOWY_ENV_OWNERS: "dev",
	},
	stdio: ["ignore", "inherit", "inherit"],
	// Own process group, so the kill below also reaches the node and workerd children of vp.
	detached: true,
});

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
	// These three routes read workflowy.com's session-based internal API, which the fake upstream does not model and the smoke must never reach.
	await page.route("**/api/v1/home", async (route) => route.fulfill({json: {layoutMode: "bullets"}}));
	await page.route("**/api/v1/tags", async (route) => route.fulfill({json: {colors: {}}}));
	await page.route("**/api/v1/preferences", async (route) => route.fulfill({json: preferences}));
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
} catch (error) {
	failure = error;
	console.error(upstream.requests.slice(-10));
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
