import {BackupNodeSchema, MetadataSchema} from "@outlinedb/shared/schemas";
import {describe, expect, it} from "vite-plus/test";

/**
 * Regression test for Workflowy's "tables" feature. A node rendered as a table
 * carries `metadata.table = {headers: true}`. `MetadataSchema` is `.strict()`,
 * so an undeclared key makes a whole backup import abort with an
 * `unrecognized_keys` ZodError. The field is accepted-but-ignored: no consumer
 * reads it, it just must not be rejected.
 */
describe("MetadataSchema table field", () =>
{
	it("accepts the table key on metadata", () =>
	{
		const result = MetadataSchema.parse(
			{
				table:
				{
					headers: true,
				},
			},
		);
		expect(result.table).toStrictEqual(
			{
				headers: true,
			},
		);
	});

	it("accepts a node whose metadata carries a table", () =>
	{
		const node = BackupNodeSchema.parse(
			{
				id: "abc",
				nm: "A table node",
				metadata:
				{
					table:
					{
						headers: true,
					},
				},
			},
		);
		expect(node.metadata.table).toStrictEqual(
			{
				headers: true,
			},
		);
	});

	it("accepts the skipHeaders key on a table", () =>
	{
		const result = MetadataSchema.parse(
			{
				table:
				{
					skipHeaders: true,
				},
			},
		);
		expect(result.table).toStrictEqual(
			{
				skipHeaders: true,
			},
		);
	});

	it("accepts a table carrying both headers and skipHeaders", () =>
	{
		const result = MetadataSchema.parse(
			{
				table:
				{
					headers: true,
					skipHeaders: false,
				},
			},
		);
		expect(result.table).toStrictEqual(
			{
				headers: true,
				skipHeaders: false,
			},
		);
	});
});

describe("CalendarSchema day_prefix field", () =>
{
	it("accepts the day_prefix key on calendar metadata", () =>
	{
		const result = MetadataSchema.parse(
			{
				calendar:
				{
					root: true,
					day_prefix: true,
				},
			},
		);
		expect(result.calendar).toStrictEqual(
			{
				root: true,
				day_prefix: true,
			},
		);
	});

	it("accepts a node whose calendar metadata carries day_prefix", () =>
	{
		const node = BackupNodeSchema.parse(
			{
				id: "abc",
				nm: "📆 Calendar",
				metadata:
				{
					calendar:
					{
						root: true,
						day_prefix: true,
					},
				},
			},
		);
		expect(node.metadata.calendar?.day_prefix).toBe(true);
	});
});

/**
 * Regression test for video attachments. Uploading a video puts
 * `metadata.video = {duration: <seconds>}` on the node. `MetadataSchema` is
 * `.strict()`, so a single video anywhere in the tree aborted the entire backup
 * import with an `unrecognized_keys` ZodError. Accepted-but-ignored: no consumer
 * reads the duration, it just must not be rejected.
 */
describe("MetadataSchema video field", () =>
{
	it("accepts the video key on metadata", () =>
	{
		const result = MetadataSchema.parse(
			{
				video:
				{
					duration: 12.542,
				},
			},
		);
		expect(result.video).toStrictEqual(
			{
				duration: 12.542,
			},
		);
	});

	it("accepts a node whose metadata carries a video attachment", () =>
	{
		const node = BackupNodeSchema.parse(
			{
				id: "abc",
				nm: "🎥 Emu wrangling video",
				metadata:
				{
					video:
					{
						duration: 12.542,
					},
				},
			},
		);
		expect(node.metadata.video?.duration).toBe(12.542);
	});
});
