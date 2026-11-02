// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {ExportDialog} = await import("../src/client/components/export-dialog.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

let root: Root | undefined;
let host: HTMLElement | undefined;
const writes:
{
	type: string;
	blob: Blob;
}[] = [];

const tree =
{
	items: [
		{
			id: "a",
			name: "Alpha",
			note: "",
			layoutMode: null,
			numberedStart: null,
			completed: false,
			children: [],
		},
	],
};

async function run(change: () => void): Promise<void>
{
	await act(async () =>
	{
		change();
		await Promise.resolve();
	});
}

/** Lets the fetches, the writer and React settle. */
async function settle(): Promise<void>
{
	for (let turn = 0; turn < 10; turn++)
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
	writes.length = 0;
	localStorage.clear();
	URL.createObjectURL = vi.fn<() => string>(() => "blob:preview");
	URL.revokeObjectURL = vi.fn<() => void>();
	class FakeClipboardItem
	{
		constructor(readonly items: Record<string, Blob>)
		{
		}
	}
	vi.stubGlobal("ClipboardItem", FakeClipboardItem);
	Object.defineProperty(
		navigator,
		"clipboard",
		{
			configurable: true,
			value:
			{
				write: vi.fn<(items: FakeClipboardItem[]) => Promise<void>>(async (items) =>
				{
					for (const item of items)
					{
						for (const [type, blob] of Object.entries(item.items))
						{
							writes.push(
								{
									type,
									blob,
								},
							);
						}
					}
					return Promise.resolve();
				}),
			},
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) =>
			Promise.resolve(
				input === "/api/v1/nodes/export-tree"
					? Response.json(tree)
					: new Response(
							"{}",
							{
								status: 503,
							},
						),
			),
		),
	);
});

afterEach(async () =>
{
	await run(() =>
	{
		root?.unmount();
	});
	host?.remove();
	useOutlineStore.setState(
		{
			exportDialogOpen: false,
			exportContext: null,
			zoomedNodeId: null,
		},
	);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function open(): Promise<void>
{
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const client = new QueryClient(
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
	await run(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client,
				},
				createElement(ExportDialog),
			),
		);
	});
	await run(() =>
	{
		useOutlineStore.getState().openExportDialog(
			{
				nodeIds: ["a"],
				ignoreSearch: false,
			},
		);
	});
	await settle();
}

function tabs(): HTMLButtonElement[]
{
	return [...document.querySelectorAll<HTMLButtonElement>(".dialog-box button.flex-1")];
}

function button(text: string): HTMLButtonElement
{
	const found = [...document.querySelectorAll<HTMLButtonElement>(".dialog-box button")].find(
		(candidate) => candidate.textContent === text,
	);
	if (!found)
	{
		throw new Error(`no ${text} button`);
	}
	return found;
}

describe("ExportDialog", () =>
{
	it("lists the tabs in upstream order with only the selected one lacking !bg-primary", async () =>
	{
		await open();

		expect(tabs().map((tab) => [tab.textContent, tab.className.includes("!bg-primary")])).toStrictEqual([
			["Formatted", false],
			["Markdown", true],
			["Plain Text", true],
			["OPML", true],
		]);
	});

	it("preselects the remembered format and remembers each pick", async () =>
	{
		localStorage.setItem("export.format.last", "opml");
		await open();
		const selected = tabs()
			.filter((tab) => !tab.className.includes("!bg-primary"))
			.map((tab) => tab.textContent);

		await run(() =>
		{
			button("Markdown").click();
		});

		expect([selected, localStorage.getItem("export.format.last")]).toStrictEqual([["OPML"], "markdown"]);
	});

	it("previews the export in a sandboxed iframe", async () =>
	{
		await open();
		const iframe = document.querySelector("iframe");

		expect([iframe?.title, iframe?.getAttribute("sandbox"), iframe?.getAttribute("src")]).toStrictEqual([
			"Export preview",
			"",
			"blob:preview",
		]);
	});

	it("copies rich HTML for Formatted and plain text for Markdown, flashing Copied! for 2000 ms", async () =>
	{
		await open();
		vi.useFakeTimers(
			{
				toFake: ["setTimeout"],
			},
		);

		await run(() =>
		{
			button("Copy").click();
		});
		await act(async () =>
		{
			await vi.advanceTimersByTimeAsync(2000);
		});
		await run(() =>
		{
			button("Markdown").click();
		});
		await act(async () =>
		{
			await vi.advanceTimersByTimeAsync(10);
		});
		await run(() =>
		{
			button("Copy").click();
		});
		await vi.advanceTimersByTimeAsync(0);
		const flashed = document.body.textContent.includes("Copied!");
		await act(async () =>
		{
			await vi.advanceTimersByTimeAsync(2000);
		});

		expect([
			writes.map((write) => write.type),
			flashed,
			document.body.textContent.includes("Copied!"),
		]).toStrictEqual([["text/html", "text/plain"], true, false]);
	});

	it("uses the iframe selection to copy Formatted on Android", async () =>
	{
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 14)");
		await open();
		const iframe = document.querySelector("iframe");

		expect([iframe?.getAttribute("sandbox"), writes.length]).toStrictEqual(["allow-same-origin", 0]);
	});

	it("closes on Escape", async () =>
	{
		await open();

		await run(() =>
		{
			document.body.dispatchEvent(
				new KeyboardEvent(
					"keydown",
					{
						key: "Escape",
						bubbles: true,
					},
				),
			);
		});

		expect(useOutlineStore.getState().exportDialogOpen).toBe(false);
	});

	it("closes when the zoom moves elsewhere", async () =>
	{
		await open();

		await run(() =>
		{
			useOutlineStore.setState(
				{
					zoomedNodeId: "elsewhere",
				},
			);
		});

		expect(useOutlineStore.getState().exportDialogOpen).toBe(false);
	});
});
