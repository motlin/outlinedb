import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import type {WorkflowyWriteThroughClient} from "../src/cache/workflowy-write-through-client.js";
import {deleteBacklinksOfDeleted, syncBacklinksIfLinked} from "../src/node/backlinks.js";
import {readInternalAuth} from "../src/node/session-store.js";

vi.mock("../src/node/session-store.js", () => (
{
	readInternalAuth: vi.fn<() => undefined>(() => {}),
}));

const database = {} as Parameters<typeof syncBacklinksIfLinked>[2];
const writeThrough = {} as WorkflowyWriteThroughClient;
const LINK = '<a href="https://workflowy.com/#/0123456789ab">t</a>';

describe("syncBacklinksIfLinked without an internal session", () =>
{
	afterEach(() =>
	{
		vi.mocked(readInternalAuth).mockReturnValue(undefined);
	});

	it("warns on stderr that the backlinks were skipped, and returns undefined", async () =>
	{
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const result = await syncBacklinksIfLinked(["n1"], [LINK], database, writeThrough);

		expect(
			{
				result,
				warnings: write.mock.calls.map(([text]) => String(text).split(".")[0]),
			},
		).toStrictEqual(
			{
				result: undefined,
				warnings: [
					"Warning: the text links to other items, but no internal session is configured, so no backlinks were created or removed",
				],
			},
		);
	});

	it("stays silent when the text holds no link", async () =>
	{
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await syncBacklinksIfLinked(["n1"], ["plain"], database, writeThrough);

		expect(write.mock.calls).toStrictEqual([]);
	});
});

describe("deleteBacklinksOfDeleted without an internal session", () =>
{
	it("warns on stderr that the backlink items were left, and deletes none", async () =>
	{
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const deleted = await deleteBacklinksOfDeleted(
			{
				ids: ["n1"],
				mirrors: [],
			},
			database,
			writeThrough,
		);

		expect(
			{
				deleted,
				warnings: write.mock.calls.map(([text]) => String(text).split(".")[0]),
			},
		).toStrictEqual(
			{
				deleted: [],
				warnings: [
					"Warning: the deleted items may have backlinks, but no internal session is configured, so their backlink items were not deleted",
				],
			},
		);
	});

	it("stays silent when the subtree held no backlink source", async () =>
	{
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await deleteBacklinksOfDeleted(
			{
				ids: [],
				mirrors: [],
			},
			database,
			writeThrough,
		);

		expect(write.mock.calls).toStrictEqual([]);
	});
});
