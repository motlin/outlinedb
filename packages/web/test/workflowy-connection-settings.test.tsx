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
const PASSWORD_FIELD =
{
	name: "password",
	type: "password",
	label: "Password",
};
const TRACE = "GET /login/ -> 200 set [_bess]; POST /login/ form [next, email] -> 200; jar [_bess]";

/** A login step asking for the password, as the Worker answers it. */
function passwordStep(attemptId: string, errors: string[] = []): Response
{
	return Response.json(
		{
			attemptId,
			fields: [PASSWORD_FIELD],
			errors,
			resend: [],
			detail: TRACE,
		},
	);
}

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
	it("connects by answering each field workflowy.com's form asks for, shows its errors, then imports with keep-syncing on", async () =>
	{
		const steps: Response[] = [
			Response.json(
				{
					ok: false,
					status: 422,
					error: "workflowy-login-failed",
					message: "Login failed: workflowy.com answered unexpectedly",
					detail: "HTTP 500: Server error",
				},
				{
					status: 422,
				},
			),
			passwordStep("attempt-1"),
			passwordStep("attempt-1", ["Please enter a correct email and password."]),
			// The code step echoed the password back, so the browser sends it again with the code.
			Response.json(
				{
					attemptId: "attempt-1",
					fields: [
						{
							name: "code",
							type: "text",
							label: "Code from your email",
						},
					],
					errors: [],
					resend: ["password"],
					detail: "GET /login/ -> 200; POST /login/ form [email, password] -> 200; jar [_bess]",
				},
			),
		];
		writes["POST /api/v1/workflowy-connection"] = () =>
		{
			const next = steps.shift();
			if (next !== undefined)
			{
				return next;
			}
			connection = connected();
			return Response.json(connection);
		};
		await open();
		const emailOnly = text("label > span");

		await type("workflowy-email", " alice@example.com ");
		await click(button("Connect"));
		const refused = text("[role=alert] > div");

		await click(button("Connect"));
		const askedPassword =
		{
			labels: text("label > span"),
			type: input("workflowy-login-password").type,
			emailLocked: input("workflowy-email").disabled,
			trace: text("[data-workflowy-login-trace]"),
			startOver: button("Start over")?.type,
		};
		await type("workflowy-login-password", "wrong");
		await click(button("Connect"));
		const wrong =
		{
			alerts: text("[role=alert] li"),
			password: input("workflowy-login-password").value,
		};
		await type("workflowy-login-password", "right");
		await click(button("Connect"));
		const code = input("workflowy-login-code");
		const askedCode =
		{
			labels: text("label > span"),
			autocomplete: code.autocomplete,
			inputMode: code.inputMode,
			type: code.type,
			alerts: text("[role=alert]"),
			trace: text("[data-workflowy-login-trace]"),
		};
		await type("workflowy-login-code", "123456");
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
				emailOnly,
				refused,
				askedPassword,
				wrong,
				askedCode,
				connectedStatus,
				calls,
				progress: text("[data-workflowy-import] output"),
				keepSyncing: document.querySelector(".workflowy-connection-mirror")?.classList.contains("on"),
				reimport: button("Re-import"),
			},
		).toStrictEqual(
			{
				emailOnly: ["workflowy.com email"],
				refused: ["workflowy.com didn't accept that sign-in.", "workflowy.com said: HTTP 500: Server error"],
				// The email stays editable, which starts over; each step shows the requests so far in gray.
				askedPassword:
				{
					labels: ["workflowy.com email", "Password"],
					type: "password",
					emailLocked: false,
					trace: [`Sign-in steps: ${TRACE}`],
					startOver: "button",
				},
				// The form's own errors show, and the password is cleared for another try.
				wrong:
				{
					alerts: ["Please enter a correct email and password."],
					password: "",
				},
				askedCode:
				{
					labels: ["workflowy.com email", "Code from your email"],
					autocomplete: "one-time-code",
					inputMode: "numeric",
					type: "text",
					alerts: [],
					trace: [
						"Sign-in steps: GET /login/ -> 200; POST /login/ form [email, password] -> 200; jar [_bess]",
					],
				},
				connectedStatus: ["Connected as alice@example.com", "Not synced yet"],
				calls: [
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							email: "alice@example.com",
						},
					},
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							email: "alice@example.com",
						},
					},
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							attemptId: "attempt-1",
							values:
							{
								password: "wrong",
							},
						},
					},
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							attemptId: "attempt-1",
							values:
							{
								password: "right",
							},
						},
					},
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							attemptId: "attempt-1",
							values:
							{
								code: "123456",
								password: "right",
							},
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

	it("starts over on request, on an edited email, an expired code, a captcha or a timed-out sign-in, back at the email", async () =>
	{
		const steps: Response[] = [
			passwordStep("attempt-1"),
			passwordStep("attempt-2"),
			Response.json(
				{
					ok: false,
					status: 409,
					error: "workflowy-login-code-expired",
					message: "Your verification code has expired.",
					detail: TRACE,
				},
				{
					status: 409,
				},
			),
			passwordStep("attempt-3"),
			passwordStep("attempt-4"),
			Response.json(
				{
					ok: false,
					status: 409,
					error: "workflowy-login-expired",
				},
				{
					status: 409,
				},
			),
			Response.json(
				{
					ok: false,
					status: 422,
					error: "workflowy-captcha",
					message: "workflowy.com asked for a captcha. Try again later.",
				},
				{
					status: 422,
				},
			),
		];
		writes["POST /api/v1/workflowy-connection"] = () => steps.shift() ?? Response.json(connection);
		await open();
		const before = button("Start over");
		await type("workflowy-email", "alice@example.com");
		await click(button("Connect"));
		await click(button("Start over"));
		const startedOver =
		{
			labels: text("label > span"),
			email: input("workflowy-email").value,
			startOver: button("Start over"),
		};

		await click(button("Connect"));
		await type("workflowy-login-password", "pw");
		await click(button("Connect"));
		const codeExpired =
		{
			alerts: text("[role=alert] > div"),
			labels: text("label > span"),
		};
		await click(button("Start over"));
		const cleared = text("[role=alert]");

		await click(button("Connect"));
		await type("workflowy-email", "bob@example.com");
		const edited =
		{
			labels: text("label > span"),
			email: input("workflowy-email").value,
		};

		await click(button("Connect"));
		await type("workflowy-login-password", "slow");
		await click(button("Connect"));
		const expired =
		{
			alerts: text("[role=alert] > div"),
			labels: text("label > span"),
		};
		await click(button("Connect"));
		expect(
			{
				before,
				startedOver,
				codeExpired,
				cleared,
				edited,
				expired,
				captcha: text("[role=alert] > div"),
				calls: calls.map((call) => `${call.method} ${call.path} ${JSON.stringify(call.body)}`),
			},
		).toStrictEqual(
			{
				before: undefined,
				startedOver:
				{
					labels: ["workflowy.com email"],
					email: "alice@example.com",
					startOver: undefined,
				},
				codeExpired:
				{
					alerts: ["That code expired. Start again to get a new one.", `workflowy.com said: ${TRACE}`],
					labels: ["workflowy.com email"],
				},
				cleared: [],
				edited:
				{
					labels: ["workflowy.com email"],
					email: "bob@example.com",
				},
				expired:
				{
					alerts: ["That sign-in took too long. Start again."],
					labels: ["workflowy.com email"],
				},
				captcha: ["workflowy.com wants to check you're human. Try again later."],
				// Start over and the edited email end the attempt on the server; the expired code already ended it.
				calls: [
					'POST /api/v1/workflowy-connection {"email":"alice@example.com"}',
					"DELETE /api/v1/workflowy-connection/attempt null",
					'POST /api/v1/workflowy-connection {"email":"alice@example.com"}',
					'POST /api/v1/workflowy-connection {"attemptId":"attempt-2","values":{"password":"pw"}}',
					'POST /api/v1/workflowy-connection {"email":"alice@example.com"}',
					"DELETE /api/v1/workflowy-connection/attempt null",
					'POST /api/v1/workflowy-connection {"email":"bob@example.com"}',
					'POST /api/v1/workflowy-connection {"attemptId":"attempt-4","values":{"password":"slow"}}',
					'POST /api/v1/workflowy-connection {"email":"bob@example.com"}',
				],
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
		// The import that found the session refused stopped before it found anything.
		run = importRun(
			{
				status: "expired",
				message: "workflowy-session-expired",
				applied: 0,
				found:
				{
					nodes: 0,
					completed: 0,
					mirrors: 0,
					backlinks: 0,
					expandedKeys: 0,
					stars: 0,
					starOrder: 0,
					tagColors: 0,
					savedViews: 0,
					settings: 0,
				},
				failures:
				{
					invalidNodes: 0,
					metadataSkipped: 0,
				},
				files:
				{
					found: 0,
					copied: 0,
					alreadyCopied: 0,
					failed: 0,
					bytes: 0,
					failures: [],
				},
			},
		);
		await open();
		const prompt = text("[role=alert]");
		const report = text("[data-workflowy-import] > *");
		const email = input("workflowy-email").value;

		writes["POST /api/v1/workflowy-connection"] = (body) =>
		{
			if (Reflect.has(body as object, "email"))
			{
				return passwordStep("attempt-2");
			}
			connection = connected(
				{
					mirror: true,
				},
			);
			return Response.json(connection);
		};
		await click(button("Sign in again"));
		// While signing in, the old session's expiry and its failed import give way to the sign-in; Disconnect stays.
		const signingIn =
		{
			alerts: text("[role=alert]"),
			report: text("[data-workflowy-import]"),
			disconnect: button("Disconnect")?.textContent,
		};
		await type("workflowy-login-password", "again");
		await click(button("Sign in again"));

		expect(
			{
				prompt,
				report,
				email,
				signingIn,
				calls,
				status: text("[data-workflowy-connection=status] > *"),
			},
		).toStrictEqual(
			{
				prompt: [
					"Your workflowy.com session expired, so syncing is paused. Sign in again to resume; your changes wait until then.",
					"workflowy.com refused the session, so the import stopped. Sign in again, then import.",
				],
				// No "Found 0 items" from a run that never read the outline.
				report: ["workflowy.com refused the session, so the import stopped. Sign in again, then import."],
				email: "alice@example.com",
				signingIn:
				{
					alerts: [],
					report: [],
					disconnect: "Disconnect",
				},
				calls: [
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							email: "alice@example.com",
						},
					},
					{
						method: "POST",
						path: "/api/v1/workflowy-connection",
						body:
						{
							attemptId: "attempt-2",
							values:
							{
								password: "again",
							},
						},
					},
				],
				status: ["Connected as alice@example.com", "Not synced yet"],
			},
		);
	});
});
