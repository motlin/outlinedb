import {assert, describe, expect, it} from "vite-plus/test";
import
{
	buildPhotoGroups,
	countGroupsWithoutEvidence,
	describeStaleAttachmentData,
	parseImageSequence,
	planPhotoGroup,
} from "../../src/services/photo-groups.js";
import type {CachedNodeRow, PhotoGroupMember} from "../../src/services/photo-groups.js";

const CREATED_AT = 1_700_000_000;

function row(
	overrides: Partial<CachedNodeRow> &
	{
		id: string;
	},
): CachedNodeRow
{
	return {
		parentId: null,
		name: null,
		note: null,
		priority: 0,
		childCount: 0,
		createdAt: CREATED_AT,
		isMirror: false,
		fileName: null,
		fileType: null,
		...overrides,
	};
}

/** A blank leaf with a confirmed image attachment. */
function photoRow(
	overrides: Partial<CachedNodeRow> &
	{
		id: string;
	},
): CachedNodeRow
{
	return row(
		{
			fileName: "image.jpeg",
			fileType: "image/jpeg",
			...overrides,
		},
	);
}

function member(
	overrides: Partial<PhotoGroupMember> &
	{
		id: string;
	},
): PhotoGroupMember
{
	return {
		priority: 0,
		createdAt: CREATED_AT,
		fileName: "image.jpeg",
		fileType: "image/jpeg",
		...overrides,
	};
}

describe("parseImageSequence", () =>
{
	it("extracts the sequence number from an iPhone filename", () =>
	{
		expect(parseImageSequence("IMG_3695.jpeg")).toBe(3695);
	});

	it("returns null for generic filenames", () =>
	{
		expect(parseImageSequence("image.jpeg")).toBeNull();
	});

	it("returns null when there is no filename", () =>
	{
		expect(parseImageSequence(null)).toBeNull();
	});
});

describe("buildPhotoGroups", () =>
{
	it("finds a blank wrapper whose children are all blank leaves", () =>
	{
		const rows = [
			row(
				{
					id: "entry",
					name: "Drove to a friend’s house",
					parentId: "day",
					childCount: 1,
				},
			),
			row(
				{
					id: "wrapper",
					parentId: "entry",
					childCount: 2,
				},
			),
			photoRow(
				{
					id: "photo-a",
					parentId: "wrapper",
					priority: 100,
					fileName: "IMG_2.jpeg",
				},
			),
			photoRow(
				{
					id: "photo-b",
					parentId: "wrapper",
					priority: 200,
					fileName: "IMG_1.jpeg",
				},
			),
		];

		expect(buildPhotoGroups(rows)).toStrictEqual([
			{
				kind: "wrapped",
				entryId: "entry",
				wrapperId: "wrapper",
				members: [
					member(
						{
							id: "photo-a",
							priority: 100,
							fileName: "IMG_2.jpeg",
						},
					),
					member(
						{
							id: "photo-b",
							priority: 200,
							fileName: "IMG_1.jpeg",
						},
					),
				],
			},
		]);
	});

	it("finds a run of blank leaves directly under an entry", () =>
	{
		const rows = [
			row(
				{
					id: "entry",
					name: "Flat Rock Brook",
					parentId: "day",
					childCount: 2,
				},
			),
			photoRow(
				{
					id: "photo-a",
					parentId: "entry",
					priority: 800,
					fileName: "IMG_3695.jpeg",
				},
			),
			photoRow(
				{
					id: "photo-b",
					parentId: "entry",
					priority: 900,
					fileName: "IMG_3667.jpeg",
				},
			),
		];

		expect(buildPhotoGroups(rows)).toStrictEqual([
			{
				kind: "loose",
				entryId: "entry",
				wrapperId: null,
				members: [
					member(
						{
							id: "photo-a",
							priority: 800,
							fileName: "IMG_3695.jpeg",
						},
					),
					member(
						{
							id: "photo-b",
							priority: 900,
							fileName: "IMG_3667.jpeg",
						},
					),
				],
			},
		]);
	});

	it("splits loose photos into separate runs when a text sibling interrupts them", () =>
	{
		const rows = [
			row(
				{
					id: "entry",
					name: "A day out",
					parentId: "day",
					childCount: 5,
				},
			),
			photoRow(
				{
					id: "photo-a",
					parentId: "entry",
					priority: 100,
				},
			),
			photoRow(
				{
					id: "photo-b",
					parentId: "entry",
					priority: 200,
				},
			),
			row(
				{
					id: "note",
					name: "Some commentary",
					parentId: "entry",
					priority: 300,
				},
			),
			photoRow(
				{
					id: "photo-c",
					parentId: "entry",
					priority: 400,
				},
			),
			photoRow(
				{
					id: "photo-d",
					parentId: "entry",
					priority: 500,
				},
			),
		];

		expect(buildPhotoGroups(rows).map((group) => group.members.map((groupMember) => groupMember.id))).toStrictEqual(
			[
				["photo-a", "photo-b"],
				["photo-c", "photo-d"],
			],
		);
	});

	it("ignores single blank children and blank nodes that have text children", () =>
	{
		const rows = [
			row(
				{
					id: "entry",
					name: "A day out",
					parentId: "day",
					childCount: 2,
				},
			),
			photoRow(
				{
					id: "lonely-photo",
					parentId: "entry",
					priority: 100,
				},
			),
			row(
				{
					id: "blank-parent",
					parentId: "entry",
					priority: 200,
					childCount: 2,
				},
			),
			row(
				{
					id: "text-child",
					name: "Real text",
					parentId: "blank-parent",
					priority: 100,
				},
			),
			photoRow(
				{
					id: "photo",
					parentId: "blank-parent",
					priority: 200,
				},
			),
		];

		expect(buildPhotoGroups(rows)).toStrictEqual([]);
	});

	it("ignores blank nodes with no image attachment, such as pasted table cells", () =>
	{
		const rows = [
			row(
				{
					id: "entry",
					name: "A task",
					parentId: "day",
					childCount: 1,
				},
			),
			row(
				{
					id: "table",
					name: "Table",
					parentId: "entry",
					childCount: 2,
				},
			),
			row(
				{
					id: "cell-a",
					parentId: "table",
					priority: 100,
				},
			),
			row(
				{
					id: "cell-b",
					parentId: "table",
					priority: 200,
				},
			),
		];

		expect(buildPhotoGroups(rows)).toStrictEqual([]);
	});

	it("counts clusters dropped for missing attachment data", () =>
	{
		// Attachment rows only arrive via backup imports, so a stale cache hides
		// real photo groups. buildPhotoGroups still drops them; the count is what
		// keeps the drop from being silent.
		const rows = [
			row(
				{
					id: "entry",
					name: "A day out",
					parentId: "day",
					childCount: 2,
				},
			),
			row(
				{
					id: "wrapper",
					parentId: "entry",
					priority: 100,
					childCount: 2,
				},
			),
			row(
				{
					id: "unknown-a",
					parentId: "wrapper",
					priority: 100,
				},
			),
			row(
				{
					id: "unknown-b",
					parentId: "wrapper",
					priority: 200,
				},
			),
			photoRow(
				{
					id: "known-a",
					parentId: "entry",
					priority: 200,
				},
			),
			photoRow(
				{
					id: "known-b",
					parentId: "entry",
					priority: 300,
				},
			),
		];

		expect(buildPhotoGroups(rows).map((group) => group.entryId)).toStrictEqual(["entry"]);
		expect(countGroupsWithoutEvidence(rows)).toBe(1);
	});

	it("counts nothing when every cluster has attachment data", () =>
	{
		const rows = [
			row(
				{
					id: "entry",
					name: "A day out",
					parentId: "day",
					childCount: 2,
				},
			),
			photoRow(
				{
					id: "photo-a",
					parentId: "entry",
					priority: 100,
				},
			),
			photoRow(
				{
					id: "photo-b",
					parentId: "entry",
					priority: 200,
				},
			),
		];

		expect(countGroupsWithoutEvidence(rows)).toBe(0);
	});

	it("ignores mirrors, which render blank but hold no photo", () =>
	{
		const rows = [
			row(
				{
					id: "entry",
					name: "A day out",
					parentId: "day",
					childCount: 1,
				},
			),
			row(
				{
					id: "wrapper",
					parentId: "entry",
					childCount: 3,
				},
			),
			row(
				{
					id: "mirror-a",
					parentId: "wrapper",
					priority: 100,
					isMirror: true,
				},
			),
			row(
				{
					id: "mirror-b",
					parentId: "wrapper",
					priority: 200,
					isMirror: true,
				},
			),
			photoRow(
				{
					id: "photo",
					parentId: "wrapper",
					priority: 300,
				},
			),
		];

		expect(buildPhotoGroups(rows)).toStrictEqual([]);
	});

	it("does not treat a wrapper as a loose member of its own entry", () =>
	{
		const rows = [
			row(
				{
					id: "entry",
					name: "A day out",
					parentId: "day",
					childCount: 2,
				},
			),
			row(
				{
					id: "wrapper-a",
					parentId: "entry",
					priority: 100,
					childCount: 2,
				},
			),
			photoRow(
				{
					id: "photo-a",
					parentId: "wrapper-a",
					priority: 100,
				},
			),
			photoRow(
				{
					id: "photo-b",
					parentId: "wrapper-a",
					priority: 200,
				},
			),
			row(
				{
					id: "wrapper-b",
					parentId: "entry",
					priority: 200,
					childCount: 2,
				},
			),
			photoRow(
				{
					id: "photo-c",
					parentId: "wrapper-b",
					priority: 100,
				},
			),
			photoRow(
				{
					id: "photo-d",
					parentId: "wrapper-b",
					priority: 200,
				},
			),
		];

		expect(buildPhotoGroups(rows).map((group) => [group.kind, group.wrapperId])).toStrictEqual([
			["wrapped", "wrapper-a"],
			["wrapped", "wrapper-b"],
		]);
	});

	it("treats a whitespace-only note as blank", () =>
	{
		const rows = [
			row(
				{
					id: "entry",
					name: "A day out",
					parentId: "day",
					childCount: 1,
				},
			),
			row(
				{
					id: "wrapper",
					note: "   ",
					parentId: "entry",
					childCount: 2,
				},
			),
			photoRow(
				{
					id: "photo-a",
					parentId: "wrapper",
					priority: 100,
				},
			),
			photoRow(
				{
					id: "photo-b",
					parentId: "wrapper",
					priority: 200,
				},
			),
		];

		expect(buildPhotoGroups(rows).map((group) => group.wrapperId)).toStrictEqual(["wrapper"]);
	});
});

describe("planPhotoGroup", () =>
{
	const members = [
		member(
			{
				id: "a",
				priority: 100,
				fileName: "IMG_3695.jpeg",
			},
		),
		member(
			{
				id: "b",
				priority: 200,
				fileName: "IMG_3688.jpeg",
			},
		),
		member(
			{
				id: "c",
				priority: 300,
				fileName: "IMG_3667.jpeg",
			},
		),
	];

	it("reverses a loose group whose filenames descend", () =>
	{
		expect(
			planPhotoGroup(
				{
					kind: "loose",
					entryId: "entry",
					wrapperId: null,
					members,
				},
			),
		).toStrictEqual(
			{
				decision: "reverse",
				reason: "filenames descend",
				orderedIds: ["c", "b", "a"],
			},
		);
	});

	it("leaves a group whose filenames already ascend", () =>
	{
		const ascending = [...members].toReversed().map((groupMember, index) => (
		{
			...groupMember,
			priority: (index + 1) * 100,
		}));

		expect(
			planPhotoGroup(
				{
					kind: "loose",
					entryId: "entry",
					wrapperId: null,
					members: ascending,
				},
			),
		).toStrictEqual(
			{
				decision: "already-ordered",
				reason: "filenames ascend",
				orderedIds: ["c", "b", "a"],
			},
		);
	});

	it("skips a loose group with unusable filenames", () =>
	{
		const generic = members.map((groupMember) => (
		{
			...groupMember,
			fileName: "image.jpeg",
		}));

		expect(
			planPhotoGroup(
				{
					kind: "loose",
					entryId: "entry",
					wrapperId: null,
					members: generic,
				},
			),
		).toStrictEqual(
			{
				decision: "unverifiable",
				reason: "loose group without filename evidence",
				orderedIds: ["a", "b", "c"],
			},
		);
	});

	it("skips a group whose filenames are neither ascending nor descending", () =>
	{
		const jumbled = [
			member(
				{
					id: "a",
					priority: 100,
					fileName: "IMG_2.jpeg",
				},
			),
			member(
				{
					id: "b",
					priority: 200,
					fileName: "IMG_9.jpeg",
				},
			),
			member(
				{
					id: "c",
					priority: 300,
					fileName: "IMG_5.jpeg",
				},
			),
		];

		expect(
			planPhotoGroup(
				{
					kind: "wrapped",
					entryId: "entry",
					wrapperId: "w",
					members: jumbled,
				},
			),
		).toStrictEqual(
			{
				decision: "unverifiable",
				reason: "filenames are not monotonic",
				orderedIds: ["a", "b", "c"],
			},
		);
	});

	it("skips a group whose photos were added at different times", () =>
	{
		const staggered = members.map((groupMember, index) => (
		{
			...groupMember,
			createdAt: CREATED_AT + index * 3600,
		}));

		expect(
			planPhotoGroup(
				{
					kind: "wrapped",
					entryId: "entry",
					wrapperId: "w",
					members: staggered,
				},
			),
		).toStrictEqual(
			{
				decision: "unverifiable",
				reason: "photos were added at different times",
				orderedIds: ["a", "b", "c"],
			},
		);
	});

	it("blind-reverses a wrapped group with no filename evidence", () =>
	{
		const generic = members.map((groupMember) => (
		{
			...groupMember,
			fileName: null,
		}));

		expect(
			planPhotoGroup(
				{
					kind: "wrapped",
					entryId: "entry",
					wrapperId: "w",
					members: generic,
				},
			),
		).toStrictEqual(
			{
				decision: "reverse",
				reason: "wrapped group, assuming a single reversed paste",
				orderedIds: ["c", "b", "a"],
			},
		);
	});

	it("sorts members by priority before deciding", () =>
	{
		const [first, second, third] = members;
		assert(first && second && third);
		const shuffled = [third, first, second];

		expect(
			planPhotoGroup(
				{
					kind: "loose",
					entryId: "entry",
					wrapperId: null,
					members: shuffled,
				},
			).orderedIds,
		).toStrictEqual(["c", "b", "a"]);
	});
});

describe("describeStaleAttachmentData", () =>
{
	it("warns when a backup on disk is newer than the newest imported attachment row", () =>
	{
		const warning = describeStaleAttachmentData("2026-07-14 14:37:25.424", new Date("2026-07-26T00:00:00Z"));

		expect(warning).toBe(
			"attachment data is stale: newest s3_files row is 2026-07-14, but a 2026-07-26 backup is on disk. Run 'cache import-backups' first or recent photos stay invisible.",
		);
	});

	it("stays quiet when the newest backup is already imported", () =>
	{
		expect(describeStaleAttachmentData("2026-07-26 18:30:28.251", new Date("2026-07-26T00:00:00Z"))).toBeNull();
	});

	it("stays quiet when either side is unknown", () =>
	{
		expect(describeStaleAttachmentData(null, new Date("2026-07-26T00:00:00Z"))).toBeNull();
		expect(describeStaleAttachmentData("2026-07-14 14:37:25.424", null)).toBeNull();
	});

	it("stays quiet rather than warning on an unparsable timestamp", () =>
	{
		expect(describeStaleAttachmentData("not-a-timestamp", new Date("2026-07-26T00:00:00Z"))).toBeNull();
	});
});
