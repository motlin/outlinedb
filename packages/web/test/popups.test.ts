import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	anotherPopupOpened,
	is,
	isVisible,
	lock,
	pop,
	requestClose,
	resetPopupsForTests,
	snapshot,
	tryPop,
	unpop,
} from "../src/client/popups.js";

beforeEach(() =>
{
	vi.useFakeTimers();
	resetPopupsForTests();
});

afterEach(() =>
{
	resetPopupsForTests();
	vi.useRealTimers();
});

describe("popup registry", () =>
{
	it("starts empty", () =>
	{
		expect(
			{
				snapshot: snapshot(),
				visible: isVisible(),
			},
		).toStrictEqual(
			{
				snapshot:
				{
					id: undefined,
					locked: false,
				},
				visible: false,
			},
		);
	});

	it("pop replaces the current popup", () =>
	{
		pop("CTX_MENU_POPUP");
		pop("COLORS_POPUP");
		expect(snapshot()).toStrictEqual(
			{
				id: "COLORS_POPUP",
				locked: false,
			},
		);
	});

	it("tryPop refuses while a different popup is current and accepts the same id", () =>
	{
		pop("CTX_MENU_POPUP");
		const refused = tryPop("COLORS_POPUP");
		const same = tryPop("CTX_MENU_POPUP");
		expect(
			{
				refused,
				same,
				snapshot: snapshot(),
			},
		).toStrictEqual(
			{
				refused: false,
				same: true,
				snapshot:
				{
					id: "CTX_MENU_POPUP",
					locked: false,
				},
			},
		);
	});

	it("unpop of a different id leaves the slot, and unpop() clears it", () =>
	{
		pop("CTX_MENU_POPUP");
		const other = unpop("COLORS_POPUP");
		const kept = snapshot();
		const cleared = unpop();
		expect(
			{
				other,
				kept,
				cleared,
				after: snapshot(),
			},
		).toStrictEqual(
			{
				other: false,
				kept:
				{
					id: "CTX_MENU_POPUP",
					locked: false,
				},
				cleared: true,
				after:
				{
					id: undefined,
					locked: false,
				},
			},
		);
	});

	it("requestClose clears the slot after the delay", () =>
	{
		pop("CTX_MENU_POPUP");
		requestClose("CTX_MENU_POPUP", 150);
		const before = snapshot().id;
		vi.advanceTimersByTime(150);
		expect(
			{
				before,
				after: snapshot().id,
			},
		).toStrictEqual(
			{
				before: "CTX_MENU_POPUP",
				after: undefined,
			},
		);
	});

	it("requestClose is skipped when the popup is locked", () =>
	{
		pop("CTX_MENU_POPUP");
		requestClose("CTX_MENU_POPUP", 150);
		lock("CTX_MENU_POPUP");
		vi.advanceTimersByTime(200);
		expect(snapshot()).toStrictEqual(
			{
				id: "CTX_MENU_POPUP",
				locked: true,
			},
		);
	});

	it("requestClose is skipped when the slot changed in between", () =>
	{
		pop("CTX_MENU_POPUP");
		requestClose("CTX_MENU_POPUP", 150);
		pop("COLORS_POPUP");
		vi.advanceTimersByTime(200);
		expect(snapshot()).toStrictEqual(
			{
				id: "COLORS_POPUP",
				locked: false,
			},
		);
	});

	it("anotherPopupOpened is false for the current id and true for any other", () =>
	{
		pop("CTX_MENU_POPUP");
		expect(
			{
				self: anotherPopupOpened("CTX_MENU_POPUP"),
				other: anotherPopupOpened("TAG_COLOR_TEASER_POPUP"),
				is: is("CTX_MENU_POPUP"),
			},
		).toStrictEqual(
			{
				self: false,
				other: true,
				is: true,
			},
		);
	});
});
