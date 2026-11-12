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
const {LinkPopup} = await import("../src/client/components/link-popup.js");

let root: Root | undefined;
let host: HTMLElement | undefined;

async function run(change: () => void): Promise<void>
{
	await act(async () =>
	{
		change();
		await Promise.resolve();
	});
}

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () =>
{
	await run(() =>
	{
		root?.unmount();
	});
	host?.remove();
	document.body.innerHTML = "";
});

function handlers()
{
	return {
		onApply: vi.fn<(link: {text: string; href: string}) => void>(),
		onUnlink: vi.fn<() => void>(),
		onCancel: vi.fn<() => void>(),
	};
}

async function show(text: string, href: string, spies = handlers()): Promise<ReturnType<typeof handlers>>
{
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await run(() =>
	{
		root?.render(
			createElement(
				LinkPopup,
				{
					text,
					href,
					position: [10, 20],
					...spies,
				},
			),
		);
	});
	return spies;
}

function buttons(): HTMLButtonElement[]
{
	return [...document.querySelectorAll("button")];
}

function active(): HTMLInputElement
{
	return document.activeElement as HTMLInputElement;
}

async function type(input: HTMLInputElement, value: string): Promise<void>
{
	await run(() =>
	{
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(
			new Event(
				"input",
				{
					bubbles: true,
				},
			),
		);
	});
}

describe("LinkPopup", () =>
{
	it("a new link focuses the href field, offers Cancel/Unlink/Apply and disables Apply until both fields have text", async () =>
	{
		const spies = await show("alpha", "");
		const apply = buttons().find((button) => button.textContent === "Apply")!;

		expect(
			{
				focused: active().name,
				labels: buttons().map((button) => button.textContent),
				applyClass: apply.className,
				applyDisabled: apply.disabled,
			},
		).toStrictEqual(
			{
				focused: "href",
				labels: ["Cancel", "Unlink", "Apply"],
				applyClass: "  button disabled primary",
				applyDisabled: true,
			},
		);

		await type(active(), "example.org/x");
		await run(() =>
		{
			active().dispatchEvent(
				new KeyboardEvent(
					"keydown",
					{
						key: "Enter",
						bubbles: true,
					},
				),
			);
		});
		expect(spies.onApply.mock.calls).toStrictEqual([
			[
				{
					text: "alpha",
					href: "https://example.org/x",
				},
			],
		]);
	});

	it("an existing link focuses the text field with its whole value selected", async () =>
	{
		await show("alpha", "https://e.com");

		expect(
			{
				focused: active().name,
				selection: [active().selectionStart, active().selectionEnd],
			},
		).toStrictEqual(
			{
				focused: "text",
				selection: [0, 5],
			},
		);
	});

	it("hides Unlink when the text is itself a URL", async () =>
	{
		await show("https://e.com", "https://e.com");

		expect(buttons().map((button) => button.textContent)).toStrictEqual(["Cancel", "Apply"]);
	});

	it("Escape cancels without reaching other document listeners", async () =>
	{
		const spies = await show("alpha", "");
		const bubbled = vi.fn<() => void>();
		const onBubble = () =>
		{
			bubbled();
		};
		document.addEventListener("keydown", onBubble);

		await run(() =>
		{
			active().dispatchEvent(
				new KeyboardEvent(
					"keydown",
					{
						key: "Escape",
						bubbles: true,
					},
				),
			);
		});
		document.removeEventListener("keydown", onBubble);

		expect(
			{
				cancelled: spies.onCancel.mock.calls.length,
				bubbled: bubbled.mock.calls.length,
			},
		).toStrictEqual(
			{
				cancelled: 1,
				bubbled: 0,
			},
		);
	});
});
