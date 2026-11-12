// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {CopyCodeButton} = await import("../src/client/components/copy-code-button.js");

let root: Root | undefined;
let host: HTMLElement | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () =>
{
	vi.useRealTimers();
	vi.unstubAllGlobals();
	await act(async () =>
	{
		root?.unmount();
		await Promise.resolve();
	});
	host?.remove();
});

async function mount(plainText: string): Promise<void>
{
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
	{
		root?.render(
			createElement(
				CopyCodeButton,
				{
					plainText,
				},
			),
		);
		await Promise.resolve();
	});
}

function state():
{
	icon: string | null | undefined;
	label: string;
	title: string | null | undefined;
}
{
	return {
		icon: host?.querySelector("svg")?.getAttribute("data-icon"),
		label: host?.querySelector("span")?.textContent ?? "",
		title: host?.querySelector("button")?.getAttribute("title"),
	};
}

describe("CopyCodeButton", () =>
{
	it("copies the plain text, shows Copied! with a check for two seconds, then resets", async () =>
	{
		vi.useFakeTimers();
		const writeText = vi.fn<(text: string) => Promise<void>>(async () => Promise.resolve());
		vi.stubGlobal(
			"navigator",
			{
				clipboard:
				{
					writeText,
				},
			},
		);
		await mount("a\n  b");
		const before = state();
		await act(async () =>
		{
			host?.querySelector("button")?.dispatchEvent(
				new MouseEvent(
					"click",
					{
						bubbles: true,
					},
				),
			);
			await Promise.resolve();
		});
		const during = state();
		await act(async () =>
		{
			vi.advanceTimersByTime(2000);
			await Promise.resolve();
		});
		expect(
			{
				before,
				during,
				after: state(),
				written: writeText.mock.calls,
			},
		).toStrictEqual(
			{
				before:
				{
					icon: "copy",
					label: "",
					title: "Copy code",
				},
				during:
				{
					icon: "check",
					label: "Copied!",
					title: "Copy code",
				},
				after:
				{
					icon: "copy",
					label: "",
					title: "Copy code",
				},
				written: [["a\n  b"]],
			},
		);
	});

	it("has the upstream wrapper and button classes", async () =>
	{
		await mount("x");
		expect([host?.firstElementChild?.className, host?.querySelector("button")?.className]).toStrictEqual([
			"absolute top-0 right-0 flex flex-row items-center text-xs",
			"shape-square iconButton md p-1 m-1 bg-transparent",
		]);
	});
});
