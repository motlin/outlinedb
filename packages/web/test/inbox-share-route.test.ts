import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vite-plus/test";
import {InboxMissing} from "@workflowy/shared/internal";
import type {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";

const NOT_CONFIGURED =
	"Workflowy internal API is not configured (set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD, or run './bin/run.js internal login')";
const INBOX = "00000000-0000-4000-8000-0123456789ab";

function setup(options: {configured?: boolean; add?: WorkflowyInternalAdapter["addToInbox"]} = {}) {
	const configured = options.configured ?? true;
	const adapter = {
		addToInbox: vi.fn<WorkflowyInternalAdapter["addToInbox"]>(
			options.add ?? (async () => Promise.resolve({inboxId: INBOX, id: "new-item"})),
		),
	};
	const ctx = {
		apiKey: configured ? "key" : undefined,
		internalAdapter: () => (configured ? (adapter as unknown as WorkflowyInternalAdapter) : undefined),
	} as unknown as ServerContext;
	const app = httpAppFor(ctx);
	const share = async (query: string) => {
		const res = await app.fetch(new Request(`http://x/api/v1/inbox/share${query}`));
		return {
			status: res.status,
			location: res.headers.get("Location"),
			body: res.status === 302 ? null : ((await res.json()) as unknown),
		};
	};
	return {adapter, share};
}

describe("GET /api/v1/inbox/share", () => {
	it("adds the shared title, text and url as one Inbox item, HTML-escaped, then opens the Inbox", async () => {
		const {adapter, share} = setup();

		const response = await share(
			`?title=${encodeURIComponent("Tom & Jerry <3")}&text=${encodeURIComponent("A cartoon")}&url=${encodeURIComponent("https://example.com/a?b=1&c=2")}`,
		);

		expect({response, calls: adapter.addToInbox.mock.calls}).toStrictEqual({
			response: {status: 302, location: "/#/0123456789ab", body: null},
			calls: [[{name: "Tom &amp; Jerry &lt;3 A cartoon https://example.com/a?b=1&amp;c=2"}]],
		});
	});

	it("skips blank fields and a url the text already contains", async () => {
		const {adapter, share} = setup();

		await share(
			`?title=&text=${encodeURIComponent("Look https://example.com")}&url=${encodeURIComponent("https://example.com")}`,
		);
		await share(`?url=${encodeURIComponent("https://example.com")}`);

		expect(adapter.addToInbox.mock.calls).toStrictEqual([
			[{name: "Look https://example.com"}],
			[{name: "https://example.com"}],
		]);
	});

	it("answers 400 without calling the adapter when nothing was shared", async () => {
		const {adapter, share} = setup();

		const response = await share("?title=%20&text=");

		expect({response, calls: adapter.addToInbox.mock.calls}).toStrictEqual({
			response: {status: 400, location: null, body: {error: "Share a title, text or url"}},
			calls: [],
		});
	});

	it("answers 409 when workflowy.com has no Inbox", async () => {
		const {share} = setup({add: async () => Promise.reject(new InboxMissing())});

		await expect(share("?text=hi")).resolves.toStrictEqual({
			status: 409,
			location: null,
			body: {error: new InboxMissing().message},
		});
	});

	it("answers 503 without the internal API", async () => {
		const {share} = setup({configured: false});

		await expect(share("?text=hi")).resolves.toStrictEqual({
			status: 503,
			location: null,
			body: {error: NOT_CONFIGURED},
		});
	});
});

describe("web manifest", () => {
	const html = readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");
	const manifest: unknown = JSON.parse(
		readFileSync(new URL("../src/client/public/manifest.webmanifest", import.meta.url), "utf8"),
	);

	it("is linked from index.html and registers 'Share to OutlineDB' as a GET share target into the Inbox", () => {
		expect({
			linked: html.includes('<link rel="manifest" href="/manifest.webmanifest" />'),
			manifest,
		}).toStrictEqual({
			linked: true,
			manifest: {
				name: "OutlineDB",
				short_name: "OutlineDB",
				start_url: "/",
				scope: "/",
				display: "standalone",
				icons: [{src: "/favicon.png", sizes: "32x32", type: "image/png"}],
				share_target: {
					action: "/api/v1/inbox/share",
					method: "GET",
					params: {title: "title", text: "text", url: "url"},
				},
			},
		});
	});
});
