// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse, OutlineViewResponse} from "../src/node-types.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function row(id: string, parentId: string | null, hasChildren: boolean): NodeResponse
{
	return {
		id,
		parent_id: parentId,
		name: id,
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		completedAt: null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren,
		hasUncompletedChildren: hasChildren,
	};
}

const NO_BACKLINKS =
{
	rootId: null,
	items: [],
};

// Home holds alice > bob, alice expanded.
const view: OutlineViewResponse =
{
	lists: [
		{
			parentId: null,
			nodes: [row("alice", null, true)],
			backlinks: null,
		},
		{
			parentId: "alice",
			nodes: [row("bob", "alice", false)],
			backlinks: NO_BACKLINKS,
		},
	],
};

/** What the API answers on page load, keyed by path. Anything else is a request this test does not expect. */
const responses: Partial<Record<string, () => Response>> =
{
	// The refused nodes socket below makes the client ask whether the session is still signed in.
	"/health": () =>
		Response.json(
			{
				status: "ok",
			},
		),
	"/api/v1/expansion": () =>
		Response.json(
			{
				expandedIds: ["alice"],
			},
		),
	"/api/v1/expansion/left-bar": () =>
		Response.json(
			{
				keys: [],
			},
		),
	"/api/v1/home": () =>
		Response.json(
			{
				layoutMode: "bullets",
			},
		),
	"/api/v1/preferences": () =>
		Response.json(
			{
				dateFormat: "YYYY-MM-DD ddd",
				timeFormat: "HH:mm",
				weekStartDay: null,
				slashDiscovered: true,
				notesRootId: null,
				showCompleted: true,
				showKeyboardShortcuts: false,
				changelogRead: null,
			},
		),
	"/api/v1/account": () =>
		Response.json(
			{
				userId: 7,
				joinedAt: "2020-01-02T00:00:00.000Z",
				fullName: "Alice Smith",
			},
		),
	"/api/v1/account/ai": () =>
		Response.json(
			{
				assistants: [],
				defaultAgentId: null,
				promptButtons:
				{
					draft: [],
					reply: [],
				},
				contextLimit: 500,
				mailboxId: null,
			},
		),
	"/api/v1/tags": () =>
		Response.json(
			{
				colors: {},
			},
		),
	"/api/v1/whats-new": () =>
		Response.json(
			{
				read: [],
			},
		),
	"/api/v1/features": () =>
		Response.json(
			{
				visible: [],
				enabled: {},
				available: false,
			},
		),
	"/api/v1/custom-tree": () =>
		Response.json(
			{
				rootId: null,
				rootChildren: [],
				watchedIds: [],
				sections: {},
			},
		),
	"/api/v1/stars": () =>
		Response.json(
			{
				stars: [],
			},
		),
	"/api/v1/nodes": () =>
		Response.json(
			{
				nodes: [row("alice", null, true)],
			},
		),
	"/api/v1/nodes/view": () => Response.json(view),
	"/api/v1/nodes/changes": () =>
		Response.json(
			{
				latest: "0",
				reset: false,
				changedIds: [],
				deletedIds: [],
				children: [],
			},
		),
};

// Loaded once up front so the cold module transform is not charged to the test's own timeout.
const {App} = await import("../src/client/app.js");

let root: Root | undefined;
let unexpected: string[] = [];

/** A nodes socket the server refuses: it closes without ever opening, which makes the client probe `/health`. */
class RefusedWebSocket extends EventTarget
{
	readyState = 0;
	constructor(_url: string)
	{
		super();
		queueMicrotask(() =>
		{
			this.readyState = 3;
			this.dispatchEvent(new Event("close"));
		});
	}
	close(): void
	{
		this.readyState = 3;
	}
}

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	unexpected = [];
	vi.stubGlobal("WebSocket", RefusedWebSocket);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input) =>
		{
			const url = new URL(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				location.href,
			);
			const respond = responses[url.pathname];
			if (respond === undefined)
			{
				unexpected.push(url.pathname);
				return Promise.resolve(
					Response.json(
						{},
						{
							status: 404,
						},
					),
				);
			}
			return Promise.resolve(respond());
		}),
	);
});

afterEach(async () =>
{
	const {act} = await import("react");
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("app console", () =>
{
	it("loads Home without a console error or warning", async () =>
	{
		const errors = vi.spyOn(console, "error");
		const warnings = vi.spyOn(console, "warn");
		const {act, createElement, StrictMode} = await import("react");
		const {createRoot} = await import("react-dom/client");
		const container = document.createElement("div");
		document.body.append(container);
		act(() =>
		{
			root = createRoot(container);
			root.render(createElement(StrictMode, null, createElement(App)));
		});
		await act(async () =>
		{
			await vi.waitFor(() =>
			{
				expect(container.textContent).toContain("bob");
			});
		});
		expect(
			{
				bob: container.textContent.includes("bob"),
				errors: errors.mock.calls,
				warnings: warnings.mock.calls,
				unexpected,
			},
		).toStrictEqual(
			{
				bob: true,
				errors: [],
				warnings: [],
				unexpected: [],
			},
		);
	});

	it("re-evaluates (as a hot update does) without the timeoutManager provider-switch error", async () =>
	{
		const {timeoutManager} = await import("@tanstack/react-query");
		await import("../src/client/app.js");
		// A live page has armed query timers by the time a hot update re-runs the module.
		timeoutManager.clearTimeout(timeoutManager.setTimeout(() => {}, 5000));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.resetModules();
		await import("../src/client/app.js");
		expect(errors.mock.calls).toStrictEqual([]);
	});
});
