import {describe, expect, it} from "vite-plus/test";
import {aspect, previewWidth} from "../src/client/components/file-preview-layout.js";

describe("aspect", () =>
{
	it("floors height over width to two decimals, null when the size is unknown", () =>
	{
		expect([
			aspect(1440, 1020),
			aspect(600, 400),
			aspect(3, 1),
			aspect(null, 400),
			aspect(600, null),
		]).toStrictEqual([0.7, 0.66, 0.33, null, null]);
	});
});

describe("previewWidth", () =>
{
	const base =
	{
		zoomedIn: false,
		innerWidth: 1440,
		thumbs: false,
		w: 1440,
		pixels: 1,
	};

	it("caps a big preview at 700 plus the 2px border, a thumbnail at 200 plus the border", () =>
	{
		expect([
			previewWidth(base),
			previewWidth(
				{
					...base,
					thumbs: true,
				},
			),
		]).toStrictEqual([702, 202]);
	});

	it("divides the original width by the pixel density, and treats a missing density as 1", () =>
	{
		expect([
			previewWidth(
				{
					...base,
					w: 1000,
					pixels: 2.5,
				},
			),
			previewWidth(
				{
					...base,
					w: 300,
					pixels: null,
				},
			),
			previewWidth(
				{
					...base,
					w: 300,
					pixels: 0,
				},
			),
		]).toStrictEqual([402, 302, 302]);
	});

	it("never exceeds the window, and fills it when zoomed into the image", () =>
	{
		expect([
			previewWidth(
				{
					...base,
					innerWidth: 500,
				},
			),
			previewWidth(
				{
					...base,
					zoomedIn: true,
				},
			),
			previewWidth(
				{
					...base,
					zoomedIn: true,
					innerWidth: 900,
				},
			),
		]).toStrictEqual([500, 1440, 900]);
	});

	it("defaults the original size to 600x400 when unknown", () =>
	{
		expect(
			previewWidth(
				{
					...base,
					w: null,
				},
			),
		).toBe(602);
	});
});
