import {describe, expect, it, vi} from "vite-plus/test";
import {claimEscape, closeOnEscape} from "../src/client/menu-escape.js";

function key(name: string):
{
	key: string;
	preventDefault: () => void;
	prevented: () => boolean;
}
{
	let prevented = false;
	return {
		key: name,
		preventDefault: () =>
		{
			prevented = true;
		},
		prevented: () => prevented,
	};
}

describe("closeOnEscape", () =>
{
	it("claims Escape when it closes, so the window search Escape skips it as upstream's menus do", () =>
	{
		const close = vi.fn<() => void>();
		const escape = key("Escape");
		closeOnEscape(close)(escape);
		expect(
			{
				closed: close.mock.calls.length,
				prevented: escape.prevented(),
			},
		).toStrictEqual(
			{
				closed: 1,
				prevented: true,
			},
		);
	});

	it("ignores other keys", () =>
	{
		const close = vi.fn<() => void>();
		const enter = key("Enter");
		closeOnEscape(close)(enter);
		expect(
			{
				closed: close.mock.calls.length,
				prevented: enter.prevented(),
			},
		).toStrictEqual(
			{
				closed: 0,
				prevented: false,
			},
		);
	});
});

describe("claimEscape", () =>
{
	it("claims Escape only when the menu was open and closed, as a popup's close callback reports", () =>
	{
		const open = key("Escape");
		const shut = key("Escape");
		claimEscape(open, () => true);
		claimEscape(shut, () => false);
		expect([open.prevented(), shut.prevented()]).toStrictEqual([true, false]);
	});
});
