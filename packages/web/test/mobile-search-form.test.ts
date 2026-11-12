// @vitest-environment happy-dom
import {describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import {renderToStaticMarkup} from "react-dom/server";
import {MobileSearchFormView} from "../src/client/components/mobile-search-form.js";
import type {MobileSearchFormViewProps} from "../src/client/components/mobile-search-form.js";
import {mobileSearchBlurAction} from "../src/client/mobile-search-model.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const noop = () =>
{
};
const base: MobileSearchFormViewProps =
{
	visible: false,
	value: "",
	starred: false,
	onChange: noop,
	onFocus: noop,
	onBlur: noop,
	onClear: noop,
	onToggleStar: noop,
};

function render(props: Partial<MobileSearchFormViewProps>): HTMLFormElement
{
	const host = document.createElement("div");
	host.innerHTML = renderToStaticMarkup(
		createElement(
			MobileSearchFormView,
			{
				...base,
				...props,
			},
		),
	);
	return host.firstElementChild as HTMLFormElement;
}

describe("MobileSearchFormView", () =>
{
	it("is a hidden 44px form with a 17px Search input", () =>
	{
		const form = render({});
		const input = form.querySelector("input");
		expect(
			{
				className: form.className,
				inputClass: input?.className,
				placeholder: input?.getAttribute("placeholder"),
				autocomplete: input?.getAttribute("autocomplete"),
				star: form.querySelectorAll("[data-icon='star']").length,
			},
		).toStrictEqual(
			{
				className:
					"hidden wf-header h-[44px] bg-primary border-b border-solid border-primary flex flex-row items-center px-l gap-m",
				inputClass:
					"newMobileSearchBox searchBoxInput flex-1 text-[17px] text-primary border-0 bg-primary placeholder:text-tertiary",
				placeholder: "Search",
				autocomplete: "off",
				star: 0,
			},
		);
	});

	it("shows as a block with a star and clear button once there is a query", () =>
	{
		const form = render(
			{
				visible: true,
				value: "abc",
				starred: true,
			},
		);
		expect(
			{
				block: form.classList.contains("block"),
				hidden: form.classList.contains("hidden"),
				icons: [...form.querySelectorAll("svg")].map(
					(icon) => `${icon.getAttribute("data-prefix")}:${icon.getAttribute("data-icon")}`,
				),
			},
		).toStrictEqual(
			{
				block: true,
				hidden: false,
				icons: ["fas:magnifying-glass", "fas:star", "fas:circle-xmark"],
			},
		);
	});

	it("blurs on Enter, reports the blur value and clears on the clear button", () =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		const onBlur = vi.fn<(value: string) => void>();
		const onClear = vi.fn<() => void>();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		act(() =>
		{
			root.render(
				createElement(
					MobileSearchFormView,
					{
						...base,
						visible: true,
						value: "abc",
						onBlur,
						onClear,
					},
				),
			);
		});
		const input = host.querySelector("input");
		act(() =>
		{
			input?.focus();
		});
		act(() =>
		{
			input?.dispatchEvent(
				new KeyboardEvent(
					"keydown",
					{
						key: "Enter",
						bubbles: true,
					},
				),
			);
		});
		act(() =>
		{
			host.querySelector<HTMLElement>("[data-icon='circle-xmark']")?.parentElement?.click();
		});
		act(() =>
		{
			root.unmount();
		});
		expect(
			{
				blurs: onBlur.mock.calls,
				clears: onClear.mock.calls.length,
			},
		).toStrictEqual(
			{
				blurs: [["abc"]],
				clears: 1,
			},
		);
	});
});

describe("mobileSearchBlurAction", () =>
{
	it("commits a query and cancels an empty one", () =>
	{
		expect([mobileSearchBlurAction("abc"), mobileSearchBlurAction("")]).toStrictEqual(["commit", "cancel"]);
	});
});
