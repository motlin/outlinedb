// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {act, createElement, useEffect} from "react";
import type {RefObject} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {useDateAutocomplete} from "../src/client/components/date-autocomplete.js";
import {setAccountFeatures} from "../src/client/features.js";
import {is, pop, resetPopupsForTests, unpop} from "../src/client/popups.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
const editorRef: RefObject<HTMLElement | null> =
{
	current: null,
};
const bridge:
{
	handleInput: () => void;
} =
{
	handleInput: () =>
	{
	},
};

function Harness()
{
	const api = useDateAutocomplete(
		{
			editorRef,
			dateSettings:
			{
				dateFormat: "YYYY-MM-DD",
				timeFormat: "24",
			} as never,
			isBlocked: () => false,
			onApply: () =>
			{
			},
			onOpenPicker: () =>
			{
			},
			onOpenSettings: () =>
			{
			},
		},
	);
	useEffect(() =>
	{
		bridge.handleInput = api.handleInput;
	});
	return createElement(
		"div",
		null,
		createElement(
			"div",
			{
				ref: (element: HTMLElement | null) =>
				{
					// oxlint-disable-next-line react-hooks-js/immutability -- test bridge to a module-level ref
					editorRef.current = element;
				},
				id: "editor",
			},
			"tomorrow",
		),
		api.flyout,
	);
}

function typeAtEnd(): void
{
	const editor = document.querySelector("#editor");
	if (!editor?.firstChild)
	{
		throw new Error("no editor");
	}
	const range = document.createRange();
	range.setStart(editor.firstChild, 8);
	range.collapse(true);
	const selection = globalThis.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	act(() =>
	{
		bridge.handleInput();
	});
}

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
	{
		root?.render(createElement(Harness));
	});
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	host?.remove();
	for (const element of document.body.querySelectorAll(".flyout"))
	{
		element.remove();
	}
	resetPopupsForTests();
});

const flyouts = () => document.querySelectorAll(".flyout").length;

describe("date autocomplete popup guard", () =>
{
	it("shows the flyout and registers date.autocomplete when no popup is open", () =>
	{
		typeAtEnd();
		expect(
			{
				flyouts: flyouts(),
				registered: is("date.autocomplete"),
			},
		).toStrictEqual(
			{
				flyouts: 1,
				registered: true,
			},
		);
	});

	it("stays hidden while the selection toolbar is registered, and shows after it closes", () =>
	{
		pop("CTX_MENU_POPUP");
		typeAtEnd();
		const blocked = flyouts();
		unpop();
		typeAtEnd();
		expect(
			{
				blocked,
				after: flyouts(),
			},
		).toStrictEqual(
			{
				blocked: 0,
				after: 1,
			},
		);
	});

	it("unregisters when hidden", () =>
	{
		typeAtEnd();
		const sel = globalThis.getSelection();
		sel?.removeAllRanges();
		act(() =>
		{
			bridge.handleInput();
		});
		expect(
			{
				flyouts: flyouts(),
				registered: is("date.autocomplete"),
			},
		).toStrictEqual(
			{
				flyouts: 0,
				registered: false,
			},
		);
	});
});

describe("dates flag", () =>
{
	it("never shows the flyout when the account flag is off", () =>
	{
		setAccountFeatures({});
		try
		{
			typeAtEnd();
			expect(
				{
					flyouts: flyouts(),
					registered: is("date.autocomplete"),
				},
			).toStrictEqual(
				{
					flyouts: 0,
					registered: false,
				},
			);
		}
		finally
		{
			setAccountFeatures(null);
		}
	});
});
