// @vitest-environment happy-dom
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {WorkflowyConnection, WorkflowyImportRun} from "../src/node-types.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {WorkflowySection} = await import("../src/client/components/workflowy-connection-settings.js");

interface Call
{
	method: string;
	path: string;
	body: unknown;
}

let root: Root | undefined;
let host: HTMLElement | undefined;
const calls: Call[] = [];
/** What the fake Worker answers: the GETs read these, and each write's handler may change them. */
let connection: WorkflowyConnection =
{
	connected: false,
};
let run: WorkflowyImportRun | null = null;
let writes: Partial<Record<string, (body: unknown) => Response>> = {};

const FINISHED = Date.UTC(2026, 10, 22, 12, 0);

function connected(
	overrides: Partial<
		Extract<
			WorkflowyConnection,
			{
				connected: true;
			}
		>
	> = {},
): WorkflowyConnection
{
	return {
		connected: true,
		status: "connected",
		email: "alice@example.com",
		mirror: false,
		lastSyncAt: null,
		...overrides,
	};
}

function importRun(overrides: Partial<WorkflowyImportRun> = {}): WorkflowyImportRun
{
	return {
		phase: "idle",
		status: "ok",
		message: null,
		startedAt: FINISHED - 60_000,
		finishedAt: FINISHED,
		applied: 120,
		found:
		{
			nodes: 120,
			completed: 3,
			mirrors: 1,
			backlinks: 0,
			expandedKeys: 4,
			stars: 2,
			starOrder: 2,
			tagColors: 0,
			savedViews: 0,
			settings: 1,
		},
		nodes:
		{
			added: 118,
			updated: 0,
			unchanged: 0,
			phasedOut: 7,
			metadataWritten: 5,
		},
		failures:
		{
			invalidNodes: 2,
			metadataSkipped: 0,
		},
		files:
		{
			found: 2,
			copied: 1,
			alreadyCopied: 0,
			failed: 1,
			bytes: 2048,
			failures: [
				{
					nodeId: "n1",
					fileName: "photo.jpg",
					error: "HTTP 403",
				},
			],
		},
		rowsRead: 0,
		rowsWritten: 0,
		...overrides,
	} as WorkflowyImportRun;
}

/** Lets the fetches and React settle. */
async function settle(): Promise<void>
{
	for (let turn = 0; turn < 5; turn++)
	{
		await act(async () =>
		{
			await new Promise<void>((resolve) =>
			{
				setTimeout(resolve, 5);
			});
		});
	}
}

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() =>
{
	calls.length = 0;
	connection =
	{
		connected: false,
	};
	run = null;
	writes = {};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (request: string | URL, init?: RequestInit) =>
		{
			const url = new URL(request, globalThis.location.origin);
			const method = init?.method ?? "GET";
			const raw = await new Response(init?.body ?? null).text();
			if (method === "GET")
			{
				return Response.json(
					url.pathname === "/api/v1/workflowy-import"
						?
							{
								run,
							}
						: connection,
				);
			}
			const body: unknown = raw === "" ? null : JSON.parse(raw);
			calls.push(
				{
					method,
					path: url.pathname,
					body,
				},
			);
			return writes[`${method} ${url.pathname}`]?.(body) ?? Response.json(connection);
		}),
	);
});

afterEach(async () =>
{
	await act(async () =>
	{
		root?.unmount();
		await Promise.resolve();
	});
	host?.remove();
	vi.unstubAllGlobals();
});

async function open(): Promise<void>
{
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(
						{
							defaultOptions:
							{
								queries:
								{
									retry: false,
								},
							},
						},
					),
				},
				createElement(WorkflowySection),
			),
		);
		await Promise.resolve();
	});
	await settle();
}

function input(name: string): HTMLInputElement
{
	const found = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
	if (!found)
	{
		throw new Error(`no ${name} input`);
	}
	return found;
}

async function type(name: string, value: string): Promise<void>
{
	const element = input(name);
	// oxlint-disable-next-line typescript/unbound-method -- called with the input as `this` below
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	await act(async () =>
	{
		setter?.call(element, value);
		element.dispatchEvent(
			new Event(
				"input",
				{
					bubbles: true,
				},
			),
		);
		await Promise.resolve();
	});
}

async function click(element: HTMLElement | null | undefined): Promise<void>
{
	if (!element)
	{
		throw new Error("nothing to click");
	}
	await act(async () =>
	{
		element.click();
		await Promise.resolve();
	});
	await settle();
}

function button(label: string): HTMLButtonElement | undefined
{
	return [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
}

function text(selector: string): string[]
{
	return [...document.querySelectorAll(selector)].map((element) =>
		element.textContent.replaceAll(/\s+/gu, " ").trim(),
	);
}

describe("Settings > Workflowy", () =>
{
	it("connects with the workflowy.com email and password, says why a login failed, then imports with keep-syncing on", async () =>
	{
		writes["POST /api/v1/workflowy-connection"] = () =>
			Response.json(
				{
					ok: false,
					status: 422,
					error: "workflowy-login-failed",
					message: "Login failed: Wrong email or password",
				},
				{
					status: 422,
				},
			);
		await open();
		const disconnectedLabels = text("label > span");

		await type("workflowy-email", " alice@example.com ");
		await type("workflowy-connection-password", "wrong");
		await click(button("Connect"));
		const refused = text("[role=alert]");

		writes["POST /api/v1/workflowy-connection"] = () =>
		{
			connection = connected();
			return Response.json(connection);
		};
		await type("workflowy-connection-password", "right");
		await click(button("Connect"));
		const connectedStatus = text("[data-workflowy-connection=status] > *");

		writes["PATCH /api/v1/workflowy-connection"] = (body) =>
		{
			connection = connected(
				{
					mirror: Reflect.get(body as object, "mirror") === true,
				},
			);
			return Response.json(connection);
		};
		writes["POST /api/v1/workflowy-import"] = () =>
		{
			run = importRun(
				{
					phase: "fetching",
					status: "running",
					finishedAt: null,
				},
			);
			return Response.json(
				{
					run,
				},
				{
					status: 202,
				},
			);
		};
		await click(input("workflowy-connection-mirror"));
		await click(button("Import"));

		expect(
			{
				disconnectedLabels,
				refused,
				connectedStatus,
				calls,
				progress: text("[data-workflowy-import] output"),
				keepSyncing: document.querySelector(".workflowy-connection-mirror")?.classList.contains("on"),
				reimport: button("Re-import"),
			},
		).toStrictEqual(
			{
				disconnectedLabels: ["workflowy.com email", "workflowy.com password"],
				refused: ["workflowy.com didn't accept that email and password."],
				connectedStatus: ["Connected as alice@example.com", "Not synced yet"],
				calls: [
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							email: "alice@example.com",
							password: "wrong",
						},
					},
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							email: "alice@example.com",
							password: "right",
						},
					},
					{
						method: "PATCH",
						path: "/api/v1/workflowy-connection",
						body:
						{
							mirror: true,
						},
					},
					{
						method: "POST",
						path: "/api/v1/workflowy-import",
						body: null,
					},
				],
				progress: ["Fetching your outline from workflowy.com"],
				keepSyncing: true,
				// No re-import while a run is under way.
				reimport: undefined,
			},
		);
	});

	it("shows live progress with the found counts while the import copies attachments", async () =>
	{
		connection = connected();
		run = importRun(
			{
				phase: "files",
				status: "running",
				finishedAt: null,
			},
		);
		await open();

		expect(text("[data-workflowy-import] > *")).toStrictEqual([
			"Copying attachments: 2 of 2",
			"Found 120 items, 3 completed items, 1 mirror, 2 attachments, 2 stars, 1 setting, 4 expanded items.",
			// Failures show as they happen, not only once the run ends.
			"2 items could not be read and were left outphoto.jpg: HTTP 403",
		]);
	});

	it("reports a finished import's results and failures, and turns keep-syncing on, re-imports and disconnects", async () =>
	{
		connection = connected(
			{
				lastSyncAt: FINISHED,
			},
		);
		run = importRun();
		await open();
		const report =
		{
			status: text("[data-workflowy-connection=status] > *"),
			results: text("[data-workflowy-import-results] li"),
			failures: text("[data-workflowy-import-failures] li"),
		};

		await click(document.querySelector<HTMLElement>(".workflowy-connection-mirror"));
		await click(button("Re-import"));
		writes["DELETE /api/v1/workflowy-connection"] = () =>
			Response.json(
				{
					connected: false,
				},
			);
		await click(button("Disconnect"));

		expect(
			{
				report,
				calls: calls.map(({method, path, body}) => [method, path, body]),
				afterDisconnect: button("Connect")?.type,
			},
		).toStrictEqual(
			{
				report:
				{
					status: ["Connected as alice@example.com", `Last sync: ${new Date(FINISHED).toLocaleString()}`],
					results: [
						"Items: 118 added, 0 updated, 0 unchanged, 7 removed",
						"Attachments: 1 copied (2.0 KB), 0 already copied, 1 failed",
					],
					failures: ["2 items could not be read and were left out", "photo.jpg: HTTP 403"],
				},
				calls: [
					[
						"PATCH",
						"/api/v1/workflowy-connection",
						{
							mirror: true,
						},
					],
					["POST", "/api/v1/workflowy-import", null],
					["DELETE", "/api/v1/workflowy-connection", null],
				],
				afterDisconnect: "submit",
			},
		);
	});

	it("asks to sign in again once workflowy.com refused the session, with the email filled in", async () =>
	{
		connection = connected(
			{
				status: "expired",
				mirror: true,
			},
		);
		await open();
		const prompt = text("[role=alert]");
		const email = input("workflowy-email").value;

		writes["POST /api/v1/workflowy-connection"] = () =>
		{
			connection = connected(
				{
					mirror: true,
				},
			);
			return Response.json(connection);
		};
		await type("workflowy-connection-password", "again");
		await click(button("Sign in again"));

		expect(
			{
				prompt,
				email,
				calls,
				status: text("[data-workflowy-connection=status] > *"),
			},
		).toStrictEqual(
			{
				prompt: [
					"Your workflowy.com session expired, so syncing is paused. Sign in again to resume; your changes wait until then.",
				],
				email: "alice@example.com",
				calls: [
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							email: "alice@example.com",
							password: "again",
						},
					},
				],
				status: ["Connected as alice@example.com", "Not synced yet"],
			},
		);
	});
});
