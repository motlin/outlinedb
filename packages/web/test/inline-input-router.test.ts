import {describe, expect, it} from "vite-plus/test";
import {routeTypedInput} from "../src/client/inline-input-router.js";

describe("routeTypedInput", () =>
{
	it("swallows the input that disarmed a chip, and saves", () =>
	{
		expect(
			routeTypedInput(
				{
					chipArmedBefore: true,
					chipArmedAfter: false,
					datePopupOpened: false,
				},
			),
		).toStrictEqual(
			{
				dateTrigger: false,
				dateAutocomplete: false,
				tagAutocomplete: false,
				detachTags: true,
				save: true,
			},
		);
	});

	it("swallows the input that armed a chip, and does not save", () =>
	{
		expect(
			routeTypedInput(
				{
					chipArmedBefore: false,
					chipArmedAfter: true,
					datePopupOpened: false,
				},
			),
		).toStrictEqual(
			{
				dateTrigger: false,
				dateAutocomplete: false,
				tagAutocomplete: false,
				detachTags: true,
				save: false,
			},
		);
	});

	it("skips the date autocomplete when the bang trigger opened the picker", () =>
	{
		expect(
			routeTypedInput(
				{
					chipArmedBefore: false,
					chipArmedAfter: false,
					datePopupOpened: true,
				},
			),
		).toStrictEqual(
			{
				dateTrigger: true,
				dateAutocomplete: false,
				tagAutocomplete: true,
				detachTags: false,
				save: true,
			},
		);
	});

	it("runs every hook on an ordinary input", () =>
	{
		expect(
			routeTypedInput(
				{
					chipArmedBefore: false,
					chipArmedAfter: false,
					datePopupOpened: false,
				},
			),
		).toStrictEqual(
			{
				dateTrigger: true,
				dateAutocomplete: true,
				tagAutocomplete: true,
				detachTags: false,
				save: true,
			},
		);
	});
});
