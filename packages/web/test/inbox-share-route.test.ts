import {readFileSync} from "node:fs";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {readPendingOutbox} from "@outlinedb/shared/cache";
import {InboxMissing} from "@outlinedb/shared/internal";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {mirrorContext, mirrorWithoutInternalApi, standaloneContext} from "./helpers/local-context.js";

const NOT_CONFIGURED = "Workflowy internal API is not configured (run './bin/run.js internal login')";
const INBOX = "00000000-0000-4000-8000-0123456789ab";

/** Seed Home > Inbox > one existing item. */
function seedInbox(ctx: ServerContext): void
{
	for (const [id, name, parentId] of [
		[INBOX, "Inbox", null],
		["existing", "Older item", INBOX],
	] as const)
	{
		ctx.cacheService.insertNode(
			{
				id,
				name,
				note: null,
				priority: 0,
				createdAt: 1_600_000_000,
				modifiedAt: 1_600_000_000,
				completedAt: null,
			},
			parentId,
		);
	}
}

async function share(ctx: ServerContext, query: string)
{
	const res = await httpAppFor(ctx).fetch(new Request(`http://x/api/v1/inbox/share${query}`));
	return {
		status: res.status,
		location: res.headers.get("Location"),
		body: res.status === 302 ? null : ((await res.json()) as unknown),
	};
}

/** The Inbox's children's names, top first. */
function inboxNames(ctx: ServerContext): (string | null)[]
{
	return ctx.cacheService.getChildren(INBOX).map(({name}) => name);
}

describe("GET /api/v1/inbox/share", () =>
{
	beforeEach(() =>
	{
		// workflowy.com is down; a share must not wait on it.
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("workflowy.com is unreachable"));
	});

	afterEach(() =>
	{
		vi.restoreAllMocks();
	});

	it("adds the shared item at the top of a mirror's Inbox locally, with pending outbox rows, then opens the Inbox", async () =>
	{
		const ctx = mirrorContext();
		seedInbox(ctx);

		const response = await share(
			ctx,
			`?title=${encodeURIComponent("Tom & Jerry <3")}&text=${encodeURIComponent("A cartoon")}&url=${encodeURIComponent("https://example.com/a?b=1&c=2")}`,
		);
		await Promise.resolve();

		const [created] = ctx.cacheService.getChildren(INBOX);
		expect(
			{
				response,
				names: inboxNames(ctx),
				pending: readPendingOutbox(ctx.db, 100).map(({nodeId, aspect}) => [nodeId, aspect]),
				drains: ctx.outboxWritten.mock.calls.length,
				fetches: vi.mocked(globalThis.fetch).mock.calls.length,
			},
		).toStrictEqual(
			{
				response:
				{
					status: 302,
					location: "/#/0123456789ab",
					body: null,
				},
				names: ["Tom &amp; Jerry &lt;3 A cartoon https://example.com/a?b=1&amp;c=2", "Older item"],
				pending: [
					[created.id, "create"],
					[created.id, "placement"],
				],
				drains: 1,
				fetches: 0,
			},
		);
	});

	it("skips blank fields and a url the text already contains", async () =>
	{
		const ctx = standaloneContext();
		seedInbox(ctx);

		await share(
			ctx,
			`?title=&text=${encodeURIComponent("Look https://example.com")}&url=${encodeURIComponent("https://example.com")}`,
		);
		await share(ctx, `?url=${encodeURIComponent("https://example.com")}`);

		expect(inboxNames(ctx)).toStrictEqual(["https://example.com", "Look https://example.com", "Older item"]);
	});

	it("answers 400 without writing when nothing was shared", async () =>
	{
		const ctx = standaloneContext();
		seedInbox(ctx);

		expect(
			{
				response: await share(ctx, "?title=%20&text="),
				names: inboxNames(ctx),
			},
		).toStrictEqual(
			{
				response:
				{
					status: 400,
					location: null,
					body:
					{
						error: "Share a title, text or url",
					},
				},
				names: ["Older item"],
			},
		);
	});

	it("answers 409 when the outline has no Inbox", async () =>
	{
		const ctx = mirrorContext();

		expect(
			{
				response: await share(ctx, "?text=hi"),
				pending: readPendingOutbox(ctx.db, 100),
			},
		).toStrictEqual(
			{
				response:
				{
					status: 409,
					location: null,
					body:
					{
						error: new InboxMissing().message,
					},
				},
				pending: [],
			},
		);
	});

	it("answers 503 for a mirror without the internal API", async () =>
	{
		await expect(share(mirrorWithoutInternalApi(), "?text=hi")).resolves.toStrictEqual(
			{
				status: 503,
				location: null,
				body:
				{
					error: NOT_CONFIGURED,
				},
			},
		);
	});
});

describe("web manifest", () =>
{
	const html = readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");
	const manifest: unknown = JSON.parse(
		readFileSync(new URL("../src/client/public/manifest.webmanifest", import.meta.url), "utf8"),
	);

	it("is linked from index.html and registers 'Share to OutlineDB' as a GET share target into the Inbox", () =>
	{
		expect(
			{
				linked: html.includes('<link rel="manifest" href="/manifest.webmanifest" />'),
				manifest,
			},
		).toStrictEqual(
			{
				linked: true,
				manifest:
				{
					name: "OutlineDB",
					short_name: "OutlineDB",
					start_url: "/",
					scope: "/",
					display: "standalone",
					icons: [
						{
							src: "/favicon.png",
							sizes: "32x32",
							type: "image/png",
						},
					],
					share_target:
					{
						action: "/api/v1/inbox/share",
						method: "GET",
						params:
						{
							title: "title",
							text: "text",
							url: "url",
						},
					},
				},
			},
		);
	});
});
