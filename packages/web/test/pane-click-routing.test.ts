import {describe, expect, it} from "vite-plus/test";
import {paneClickModifier} from "../src/client/pane-click-routing.js";

const none =
{
	button: 0,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
};

describe("paneClickModifier", () =>
{
	it("classifies the whole modifier table", () =>
	{
		expect(
			{
				alt: paneClickModifier(
					{
						...none,
						altKey: true,
					},
					true,
				),
				metaMac: paneClickModifier(
					{
						...none,
						metaKey: true,
					},
					true,
				),
				ctrlOther: paneClickModifier(
					{
						...none,
						ctrlKey: true,
					},
					false,
				),
				altOther: paneClickModifier(
					{
						...none,
						altKey: true,
					},
					false,
				),
				ctrlMac: paneClickModifier(
					{
						...none,
						ctrlKey: true,
					},
					true,
				),
				metaOther: paneClickModifier(
					{
						...none,
						metaKey: true,
					},
					false,
				),
				altShift: paneClickModifier(
					{
						...none,
						altKey: true,
						shiftKey: true,
					},
					true,
				),
				metaShift: paneClickModifier(
					{
						...none,
						metaKey: true,
						shiftKey: true,
					},
					true,
				),
				altMeta: paneClickModifier(
					{
						...none,
						altKey: true,
						metaKey: true,
					},
					true,
				),
				middle: paneClickModifier(
					{
						...none,
						button: 1,
						altKey: true,
					},
					true,
				),
				plain: paneClickModifier(none, true),
				middlePlain: paneClickModifier(
					{
						...none,
						button: 1,
					},
					true,
				),
				shiftOnly: paneClickModifier(
					{
						...none,
						shiftKey: true,
					},
					true,
				),
			},
		).toStrictEqual(
			{
				alt: "open",
				metaMac: "open",
				ctrlOther: "open",
				altOther: "open",
				ctrlMac: "other",
				metaOther: "other",
				altShift: "other",
				metaShift: "other",
				altMeta: "other",
				middle: "other",
				plain: "plain",
				middlePlain: "other",
				shiftOnly: "other",
			},
		);
	});
});
