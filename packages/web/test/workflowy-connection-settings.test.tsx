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
const {WorkflowyImportDialogHost} = await import("../src/client/components/workflowy-import-dialog.js");
const {WorkflowyImportNotice} = await import("../src/client/components/workflowy-import-notice.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

interface Call
{
	method: string;
	path: string;
	body: unknown;
}

let root: Root | undefined;
let client: QueryClient | undefined;
let host: HTMLElement | undefined;
const calls: Call[] = [];
/** What the fake Worker answers: the GETs read these, and each write's handler may change them. */
let connection: WorkflowyConnection =
{
	connected: false,
};
let run: WorkflowyImportRun | null = null;
let writes: Partial<Record<string, (body: unknown) => Response | Promise<Response>>> = {};

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
	useOutlineStore.setState(
		{
			importDialogOpen: false,
			settingsOpen: false,
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (request: string | URL, init?: RequestInit) =>
		{
			const url = new URL(request, globalThis.location.origin);
			const method = init?.method ?? "GET";
			const raw = await new Response(init?.body ?? null).text();
			if (url.pathname === "/api/auth-config")
			{
				return Response.json(
					{
						hosted: true,
						turnstileSiteKey: null,
						providers:
						{
							google: false,
							magicLink: false,
						},
						signupMode: "open",
					},
				);
			}
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

/**
 * The page as the app lays it out: the outline's import banner always, and Settings > Workflowy until the import dialog
 * opens in its place.
 */
function Page()
{
	const importing = useOutlineStore((state) => state.importDialogOpen);
	return createElement(
		"div",
		null,
		createElement(WorkflowyImportNotice),
		importing ? null : createElement(WorkflowySection),
		createElement(WorkflowyImportDialogHost),
	);
}

async function open(): Promise<void>
{
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const created = new QueryClient(
		{
			defaultOptions:
			{
				queries:
				{
					retry: false,
				},
			},
		},
	);
	client = created;
	await act(async () =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: created,
				},
				createElement(Page),
			),
		);
		await Promise.resolve();
	});
	await settle();
}

/** What a poll does: read the run again. */
async function poll(): Promise<void>
{
	await act(async () =>
	{
		await client?.invalidateQueries(
			{
				queryKey: ["workflowy-import"],
			},
		);
	});
	await settle();
}

/** The progress bars on the page, as a screen reader hears them. */
function bars(): (string | null)[][]
{
	return [...document.querySelectorAll("progress")].map((bar) => [
		bar.getAttribute("aria-label"),
		bar.getAttribute("value"),
		bar.getAttribute("max"),
		bar.getAttribute("aria-valuetext"),
	]);
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

/** The import dialog's current step. */
function step(): string[]
{
	return text("[aria-current=step] > span:last-child");
}

describe("importing from workflowy.com", () =>
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
		// Settings only points at the import dialog, which opens in its place at the Connect step.
		const settingsBefore = [...document.querySelectorAll("button")].map((candidate) => candidate.textContent);
		await click(button("Import from workflowy.com"));
		const connectStep = step();
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
		const confirm =
		{
			step: step(),
			status: text("[data-workflowy-connection=status]"),
			says: text("[data-workflowy-import-confirm] li"),
		};

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
		const importing =
		{
			step: step(),
			progress: text("[data-workflowy-import] output"),
			stages: [...document.querySelectorAll(".import-stages li")].map((stage) =>
				stage.getAttribute("data-state"),
			),
			notice: text("[data-workflowy-import-notice] p"),
			bars: bars(),
		};
		// Closing the dialog leaves the banner; Settings says an import is under way, not when the outline last synced.
		await click(button("Close and keep working"));
		await click(document.querySelector<HTMLElement>("[data-workflowy-import-notice] button"));
		const reopened = step();
		await click(button("Close and keep working"));

		expect(
			{
				settingsBefore,
				connectStep,
				emailOnly,
				refused,
				askedPassword,
				wrong,
				askedCode,
				confirm,
				importing,
				reopened,
				calls,
				notice: text("[data-workflowy-import-notice] p"),
				settings:
				{
					status: text("[data-workflowy-connection=status] > *"),
					keepSyncing: document.querySelector(".workflowy-connection-mirror")?.classList.contains("on"),
					buttons: [...document.querySelectorAll("button")].map((candidate) => candidate.textContent),
				},
			},
		).toStrictEqual(
			{
				settingsBefore: ["Import from workflowy.com"],
				connectStep: ["Connect"],
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
				confirm:
				{
					step: ["Confirm"],
					status: ["Connected as alice@example.com"],
					says: [
						"Everything in your workflowy.com account comes over: items, completed items, mirrors, attachments, stars, tag colors and saved views.",
						"It replaces your current outline here, including the tutorial.",
						"The import only reads from workflowy.com. It changes nothing there.",
					],
				},
				importing:
				{
					step: ["Import"],
					progress: ["Downloading your outline from workflowy.com"],
					stages: ["current", "upcoming", "upcoming"],
					notice: ["Importing from workflowy.com. Downloading your outline from workflowy.com"],
					// Nothing to count yet, so neither bar claims a value.
					bars: [
						["Downloading your outline from workflowy.com", null, null, null],
						["Downloading your outline from workflowy.com", null, null, null],
					],
				},
				reopened: ["Import"],
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
				notice: ["Importing from workflowy.com. Downloading your outline from workflowy.com"],
				// No re-import while a run is under way, and no "Not synced yet" beside it.
				settings:
				{
					status: [
						"Connected as alice@example.com",
						"Import in progress: Downloading your outline from workflowy.com",
					],
					keepSyncing: true,
					buttons: ["View progress", "View progress", "Disconnect"],
				},
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
		await click(button("Import from workflowy.com"));
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

	it("shows a running import in the banner and the dialog as counted progress and headline numbers, then how it ended until dismissed", async () =>
	{
		connection = connected();
		// The shape the Worker reports mid-run. Its named attachment failure is the last run's until this one retries it.
		run = importRun(
			{
				phase: "importing",
				status: "running",
				finishedAt: null,
				applied: 60,
				files:
				{
					found: 0,
					copied: 0,
					alreadyCopied: 0,
					failed: 0,
					bytes: 0,
					failures: [
						{
							nodeId: "n0",
							fileName: "old.jpg",
							error: "HTTP 500",
						},
					],
				},
			},
		);
		await open();
		const banner =
		{
			text: text("[data-workflowy-import-notice] p"),
			live: document.querySelector("[data-workflowy-import-notice] p")?.getAttribute("aria-live"),
			bars: bars(),
			status: text("[data-workflowy-connection=status] > *"),
		};
		await click(button("View progress"));
		const items =
		{
			step: step(),
			progress: text("[data-workflowy-import] output"),
			count: text("[data-workflowy-import-count]"),
			stages: [...document.querySelectorAll(".import-stages li")].map((stage) =>
				stage.getAttribute("data-state"),
			),
			found: text("[data-workflowy-import-found] .import-stat"),
			details: text("[data-workflowy-import-found] details div"),
			problems: text("[data-workflowy-import-problems]"),
			failures: text("[data-workflowy-import-failures]"),
		};

		run = importRun(
			{
				phase: "files",
				status: "running",
				finishedAt: null,
			},
		);
		await poll();
		const attachments =
		{
			banner: text("[data-workflowy-import-notice] p"),
			bars: bars(),
			found: text("[data-workflowy-import-found] .import-stat"),
			problems: text("[data-workflowy-import-problems]"),
		};

		await click(button("Close and keep working"));
		run = importRun();
		await poll();
		const finished =
		{
			banner: text("[data-workflowy-import-notice] p"),
			buttons: text("[data-workflowy-import-notice] button"),
			bars: bars(),
		};
		await click(button("Dismiss"));

		expect(
			{
				banner,
				items,
				attachments,
				finished,
				dismissed: text("[data-workflowy-import-notice]"),
			},
		).toStrictEqual(
			{
				banner:
				{
					text: ["Importing from workflowy.com. Importing items 60 of 120 items"],
					live: "polite",
					bars: [["Importing items", "60", "120", "60 of 120 items"]],
					status: ["Connected as alice@example.com", "Import in progress: Importing items, 60 of 120 items"],
				},
				items:
				{
					step: ["Import"],
					progress: ["Importing items"],
					count: ["60 of 120 items"],
					stages: ["done", "current", "upcoming"],
					found: ["Items120", "Completed3", "Mirrors1"],
					details: ["Stars2", "Settings1", "Expanded items4"],
					// This run's own count, and never the last run's named failures.
					problems: ["2 problems so far. The details show when the import ends."],
					failures: [],
				},
				attachments:
				{
					banner: ["Importing from workflowy.com. Copying attachments 2 of 2 attachments"],
					bars: [
						["Copying attachments", "2", "2", "2 of 2 attachments"],
						["Copying attachments", "2", "2", "2 of 2 attachments"],
					],
					found: ["Items120", "Completed3", "Mirrors1", "Attachments2"],
					problems: ["3 problems so far. The details show when the import ends."],
				},
				finished:
				{
					banner: ["Import finished. 120 items from workflowy.com, with 3 problems to look at."],
					buttons: ["View summary", "Dismiss"],
					bars: [],
				},
				dismissed: [],
			},
		);
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
		const settings =
		{
			status: text("[data-workflowy-connection=status] > *"),
			buttons: [...document.querySelectorAll("button")].map((candidate) => candidate.textContent),
			// A run that ended before this page loaded is not news.
			notice: text("[data-workflowy-import-notice]"),
		};
		await click(button("View last import"));
		const report =
		{
			step: step(),
			brought: text("[data-workflowy-import-found] .import-stat"),
			results: text("[data-workflowy-import-results] li"),
			failures: text("[data-workflowy-import-failures] > *"),
			keepSyncing: text(".text-tertiary").filter((hint) => hint.startsWith("Off")),
		};

		await click(document.querySelector<HTMLElement>(".workflowy-connection-mirror"));
		// The Worker is slow to answer the re-import, then fails it; meanwhile the run it started failed on its own.
		let answer: (response: Response) => void = () =>
		{
		};
		writes["POST /api/v1/workflowy-import"] = async () =>
			new Promise<Response>((resolve) =>
			{
				answer = resolve;
			});
		await click(button("Re-import"));
		const whileStarting =
		{
			step: step(),
			progress: text("[data-workflowy-import] output"),
			results: text("[data-workflowy-import-results] li"),
			notice: text("[data-workflowy-import-notice] p"),
		};
		run = importRun(
			{
				status: "error",
				message: "the tree download ran out of memory or was interrupted; not retried",
			},
		);
		await act(async () =>
		{
			answer(
				Response.json(
					{
						error: "internal",
					},
					{
						status: 500,
					},
				),
			);
			await Promise.resolve();
		});
		await settle();
		const afterFailure =
		{
			step: step(),
			alerts: text("[data-workflowy-import] [role=alert]"),
			tryAgain: button("Try again")?.type,
		};
		await click(button("Close"));
		const failedStatus = text("[data-workflowy-connection=status] > *");
		writes["DELETE /api/v1/workflowy-connection"] = () =>
			Response.json(
				{
					connected: false,
				},
			);
		await click(button("Disconnect"));

		expect(
			{
				settings,
				report,
				whileStarting,
				afterFailure,
				failedStatus,
				calls: calls.map(({method, path, body}) => [method, path, body]),
				afterDisconnect: button("Import from workflowy.com")?.type,
			},
		).toStrictEqual(
			{
				settings:
				{
					status: [
						"Connected as alice@example.com",
						`Imported 120 items, 3 problems. Last sync: ${new Date(FINISHED).toLocaleString()}`,
					],
					buttons: ["Re-import", "View last import", "Disconnect"],
					notice: [],
				},
				report:
				{
					step: ["Done"],
					brought: ["Items118", "Completed3", "Mirrors1", "Attachments of 21"],
					results: [
						"Items: 118 added, 0 updated, 0 unchanged, 7 removed",
						"Attachments: 1 copied (2.0 KB), 0 already copied, 1 failed",
					],
					// Each failure, then what to do about them.
					failures: [
						"Needs attention",
						"2 items could not be read and were left outphoto.jpg: HTTP 403",
						"Re-import to try the failed attachments again; the ones already copied are skipped. Items that were left out are still on workflowy.com.",
					],
					keepSyncing: ["Off: this was a one-time import. Nothing here is sent to workflowy.com."],
				},
				// The new run shows as soon as Re-import is clicked, not the previous run's report.
				whileStarting:
				{
					step: ["Import"],
					progress: ["Waiting to start"],
					results: [],
					notice: ["Importing from workflowy.com. Waiting to start"],
				},
				// The failed request reads the run back: its failure, not the previous run's report.
				afterFailure:
				{
					step: ["Import"],
					alerts: ["The import failed: the tree download ran out of memory or was interrupted; not retried"],
					tryAgain: "button",
				},
				failedStatus: [
					"Connected as alice@example.com",
					`The last import failed. Last sync: ${new Date(FINISHED).toLocaleString()}`,
				],
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
				afterDisconnect: "button",
			},
		);
	});

	it("asks to sign in again once workflowy.com refused the session, with the email filled in, then is back at Confirm", async () =>
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
			},
		);
		await open();
		const settings =
		{
			alerts: text("[role=alert]"),
			buttons: [...document.querySelectorAll("button")].map((candidate) => candidate.textContent),
		};
		await click(button("Sign in again"));
		const prompt =
		{
			step: step(),
			alerts: text("[role=alert] > div"),
			// No "Found 0 items" from a run that never read the outline.
			found: text("[data-workflowy-import-found]"),
			email: input("workflowy-email").value,
		};

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
		// While signing in, the old session's expiry and its stopped import give way to the sign-in.
		const signingIn = text("[role=alert]");
		await type("workflowy-login-password", "again");
		await click(button("Sign in again"));

		expect(
			{
				settings,
				prompt,
				signingIn,
				calls,
				step: step(),
				status: text("[data-workflowy-connection=status]"),
				keepSyncing: input("workflowy-connection-mirror").checked,
			},
		).toStrictEqual(
			{
				settings:
				{
					alerts: [
						"Your workflowy.com session expired, so syncing is paused. Sign in again to resume; your changes wait until then.",
					],
					buttons: ["Sign in again", "Disconnect"],
				},
				prompt:
				{
					step: ["Connect"],
					alerts: [
						"Your workflowy.com session expired, so syncing is paused. Sign in again to resume; your changes wait until then.",
						"The import stopped when the session was refused. Start it again once signed in.",
					],
					found: [],
					email: "alice@example.com",
				},
				signingIn: [],
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
				// The refused run imported nothing, so the flow is back at Confirm, with keep-syncing as it was.
				step: ["Confirm"],
				status: ["Connected as alice@example.com"],
				keepSyncing: true,
			},
		);
	});
});
