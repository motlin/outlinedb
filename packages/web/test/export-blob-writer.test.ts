// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import
{
	EXPORT_DEFAULT,
	EXPORT_OPTIONS,
	ExportBlobWriter,
	exportFileName,
	preparingLabel,
	windowsPostFormat,
} from "../src/client/export-format.js";

afterEach(() =>
{
	vi.useRealTimers();
});

describe("ExportBlobWriter", () =>
{
	it("flushes whenever 512 Ki chars are buffered, then flushes the remainder", async () =>
	{
		vi.useFakeTimers();
		const sizes: number[] = [];
		const writer = new ExportBlobWriter("text/plain", new AbortController().signal, (bytes) =>
		{
			sizes.push(bytes);
		});
		const chunk = "a".repeat(300_000);

		const done = writer.write([chunk, chunk, chunk]);
		await vi.runAllTimersAsync();
		await done;

		expect(sizes).toStrictEqual([600_000, 900_000]);
		expect(writer.blob.size).toBe(900_000);
		expect(writer.blob.type).toBe("text/plain");
	});

	it("rejects with the abort reason and stops writing", async () =>
	{
		vi.useFakeTimers();
		const controller = new AbortController();
		const sizes: number[] = [];
		const writer = new ExportBlobWriter("text/plain", controller.signal, (bytes) =>
		{
			sizes.push(bytes);
			controller.abort(new Error("switched tab"));
		});
		const chunk = "a".repeat(300_000);

		const done = writer.write([chunk, chunk, chunk]);
		const outcome = done.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : "other"),
		);
		await vi.runAllTimersAsync();

		await expect(outcome).resolves.toBe("switched tab");

		expect(sizes).toStrictEqual([600_000]);
	});
});

describe("windowsPostFormat", () =>
{
	it("turns each bare newline into CRLF", () =>
	{
		expect([windowsPostFormat("a\n"), windowsPostFormat("\n"), windowsPostFormat("a\r\n")]).toStrictEqual([
			"a\r\n",
			"\r\n",
			"a\r\n",
		]);
	});
});

describe("preparingLabel", () =>
{
	it("shows megabytes only while generating at 1 MiB or more", () =>
	{
		expect([
			preparingLabel(true, 1_048_575),
			preparingLabel(true, 1_572_864),
			preparingLabel(false, 5_000_000),
		]).toStrictEqual([null, "Preparing your export… 1.5 MB", null]);
	});
});

describe("exportFileName", () =>
{
	const now = new Date(2026, 9, 23, 12, 34, 56);

	it("names one item by its plain text without the first two punctuation or emoji characters", () =>
	{
		expect(
			exportFileName(
				[
					{
						name: "🧪 Sync sandbox",
					},
				],
				"html",
				now,
			),
		).toBe("WF - Sync sandbox - 261023-123456.html");
		expect(
			exportFileName(
				[
					{
						name: "<b>a-b-c</b> d",
					},
				],
				"md",
				now,
			),
		).toBe("WF - abc d - 261023-123456.md");
	});

	it("uses Export for several items, an empty name, and slices long names to fit 50 characters", () =>
	{
		expect([
			exportFileName(
				[
					{
						name: "a",
					},
					{
						name: "b",
					},
				],
				"html",
				now,
			),
			exportFileName(
				[
					{
						name: "!!",
					},
				],
				"txt",
				now,
			),
			exportFileName(
				[
					{
						name: "x".repeat(60),
					},
				],
				"opml",
				now,
			),
		]).toStrictEqual([
			"WF - Export - 261023-123456.html",
			"WF - Export - 261023-123456.txt",
			`WF - ${"x".repeat(24)} - 261023-123456.opml`,
		]);
	});
});

describe("EXPORT_OPTIONS", () =>
{
	it("lists Formatted, Markdown, Plain Text and OPML with html as the default", () =>
	{
		expect([Object.entries(EXPORT_OPTIONS).map(([key, {label}]) => [key, label]), EXPORT_DEFAULT]).toStrictEqual([
			[
				["html", "Formatted"],
				["markdown", "Markdown"],
				["text", "Plain Text"],
				["opml", "OPML"],
			],
			"html",
		]);
	});
});
