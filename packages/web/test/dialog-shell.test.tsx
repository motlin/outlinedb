// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {DialogShell, DialogTitle, DialogCloseButton} = await import("../src/client/components/dialog-shell.js");

let root: Root | undefined;

/** Runs `change` inside act and lets React flush it. */
async function run(change: () => void): Promise<void>
{
	await act(async () =>
	{
		change();
		await Promise.resolve();
	});
}
let host: HTMLElement | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() =>
{
	frames.length = 0;
	vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(async () =>
{
	vi.restoreAllMocks();
	await run(() =>
	{
		root?.unmount();
	});
	host?.remove();
	vi.useRealTimers();
});

async function render(element: ReturnType<typeof createElement>): Promise<void>
{
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await run(() =>
	{
		root?.render(element);
	});
}

function collapse(value: string): string
{
	return value.replaceAll(/\s+/gu, " ").trim();
}

function box(): HTMLElement
{
	const found = document.querySelector<HTMLElement>(".dialog-box");
	if (!found)
	{
		throw new Error("no dialog box");
	}
	return found;
}

function scrim(): HTMLElement
{
	return box().previousElementSibling as HTMLElement;
}

const frames: FrameRequestCallback[] = [];

async function frame(): Promise<void>
{
	await run(() =>
	{
		for (const callback of frames.splice(0))
		{
			callback(0);
		}
	});
}

describe("DialogShell instant", () =>
{
	it("drops the box transition classes but keeps the scrim's", async () =>
	{
		const {DIALOG_CLASS, SCRIM_CLASS} = await import("../src/client/components/dialog-shell.js");
		await render(
			createElement(
				DialogShell,
				{
					instant: true,
					padding: "none",
					onClose: () =>
					{
					},
				},
			),
		);
		expect(box().className).toBe(
			DIALOG_CLASS.replace(" transition-[transform,opacity] duration-300 transition-base", ""),
		);
		expect(scrim().className).toBe(SCRIM_CLASS);
	});
});

describe("DialogShell", () =>
{
	it("renders the upstream backdrop with the padded box", async () =>
	{
		await render(
			createElement(
				DialogShell,
				{
					onClose: vi.fn<() => void>(),
				},
				"body",
			),
		);
		const backdrop = document.querySelector<HTMLElement>(".dialog-backdrop");
		expect(backdrop?.className).toBe(
			"fixed top-sat left-sal right-sar bottom-sab flex items-start justify-center print:hidden dialog-backdrop",
		);
		expect(backdrop?.style.zIndex).toBe("600");
		expect(collapse(box().className)).toContain("wf-dialog dialog-box relative mt-[10vh] p-xl");
		expect(box().textContent).toBe("body");
	});

	it("keeps p-0 for padding none", async () =>
	{
		await render(
			createElement(
				DialogShell,
				{
					onClose: vi.fn<() => void>(),
					padding: "none",
				},
			),
		);
		expect(collapse(box().className)).toContain("wf-dialog dialog-box relative mt-[10vh] p-0 ");
	});

	it("enters after one frame", async () =>
	{
		await render(
			createElement(
				DialogShell,
				{
					onClose: vi.fn<() => void>(),
				},
			),
		);
		expect(scrim().style.opacity).toBe("0");
		expect(box().style.transform).toBe("translateY(-48px) scale(0.98)");
		await frame();
		expect(scrim().style.opacity).toBe("0.2");
		expect(box().style.opacity).toBe("1");
		expect(box().style.transform).toBe("");
	});

	it("closes on a scrim click", async () =>
	{
		const onClose = vi.fn<() => void>();
		await render(
			createElement(
				DialogShell,
				{
					onClose,
				},
			),
		);
		await run(() =>
		{
			scrim().click();
		});
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("closes on Escape without letting it reach window", async () =>
	{
		const onClose = vi.fn<() => void>();
		const onWindow = vi.fn<() => void>();
		window.addEventListener("keydown", onWindow);
		await render(
			createElement(
				DialogShell,
				{
					onClose,
				},
			),
		);
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
		window.removeEventListener("keydown", onWindow);
		expect(onClose).toHaveBeenCalledOnce();
		expect(onWindow).not.toHaveBeenCalled();
	});

	it("swallows Enter without closing", async () =>
	{
		const onClose = vi.fn<() => void>();
		const onWindow = vi.fn<() => void>();
		window.addEventListener("keydown", onWindow);
		await render(
			createElement(
				DialogShell,
				{
					onClose,
				},
			),
		);
		await run(() =>
		{
			document.body.dispatchEvent(
				new KeyboardEvent(
					"keydown",
					{
						key: "Enter",
						bubbles: true,
					},
				),
			);
		});
		window.removeEventListener("keydown", onWindow);
		expect(onClose).not.toHaveBeenCalled();
		expect(onWindow).not.toHaveBeenCalled();
	});

	it("stays mounted for 100ms after closing", async () =>
	{
		vi.useFakeTimers();
		await render(
			createElement(
				DialogShell,
				{
					onClose: vi.fn<() => void>(),
					open: true,
				},
			),
		);
		await run(() =>
		{
			root?.render(
				createElement(
					DialogShell,
					{
						onClose: vi.fn<() => void>(),
						open: false,
					},
				),
			);
		});
		expect(document.querySelector(".dialog-box")).not.toBeNull();
		await run(() =>
		{
			vi.advanceTimersByTime(99);
		});
		expect(document.querySelector(".dialog-box")).not.toBeNull();
		await run(() =>
		{
			vi.advanceTimersByTime(2);
		});
		expect(document.querySelector(".dialog-box")).toBeNull();
	});
});

describe("DialogTitle and DialogCloseButton", () =>
{
	it("renders the upstream title", async () =>
	{
		await render(createElement(DialogTitle, null, "Export"));
		expect(document.body.innerHTML).toContain(
			'<h1 class="title text-l leading-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis mr-3xl">Export</h1>',
		);
	});

	it("renders the cross with its halo and closes on click", async () =>
	{
		const onClose = vi.fn<() => void>();
		await render(
			createElement(
				DialogCloseButton,
				{
					onClose,
				},
			),
		);
		const button = document.querySelector<HTMLElement>(".group");
		expect(button?.style.cssText).toBe("position: absolute; top: 30px; right: 30px;");
		expect(button?.querySelector("svg")?.outerHTML).toBe(
			'<svg class="relative" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke-linecap="round" stroke="var(--wf-text-tertiary)"><line x1="1" y1="1" x2="19" y2="19"></line><line x1="19" y1="1" x2="1" y2="19"></line></svg>',
		);
		await run(() =>
		{
			button?.click();
		});
		expect(onClose).toHaveBeenCalledOnce();
	});
});
