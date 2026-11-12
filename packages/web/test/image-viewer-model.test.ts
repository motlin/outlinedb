import {describe, expect, it} from "vite-plus/test";
import {adjacentAttachment} from "../src/client/components/image-viewer-model.js";

const rows = [
	{
		id: "a",
		hasAttachment: false,
	},
	{
		id: "b",
		hasAttachment: true,
	},
	{
		id: "c",
		hasAttachment: false,
	},
	{
		id: "d",
		hasAttachment: false,
	},
	{
		id: "e",
		hasAttachment: true,
	},
	{
		id: "f",
		hasAttachment: true,
	},
];

describe("adjacentAttachment", () =>
{
	it("walks to the next row that has an attachment, skipping rows without", () =>
	{
		expect([adjacentAttachment(rows, "b", "next"), adjacentAttachment(rows, "e", "next")]).toStrictEqual([
			"e",
			"f",
		]);
	});

	it("walks backwards the same way", () =>
	{
		expect([adjacentAttachment(rows, "f", "prev"), adjacentAttachment(rows, "e", "prev")]).toStrictEqual([
			"e",
			"b",
		]);
	});

	it("is null at the ends of the zoom, and for an unknown row", () =>
	{
		expect([
			adjacentAttachment(rows, "b", "prev"),
			adjacentAttachment(rows, "f", "next"),
			adjacentAttachment(rows, "zzz", "next"),
			adjacentAttachment([], "b", "next"),
		]).toStrictEqual([null, null, null, null]);
	});
});
