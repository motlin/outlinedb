import {beforeEach, describe, expect, it, vi} from "vite-plus/test";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
	},
);
vi.stubGlobal("matchMedia", () => (
{
	matches: false,
	addEventListener: () =>
	{
	},
}));
vi.stubGlobal(
	"document",
	{
		documentElement:
		{
			dataset: {},
		},
		body:
		{
			classList:
			{
				toggle: () => true,
				contains: () => false,
			},
		},
	},
);
vi.stubGlobal("addEventListener", () => {});

const {flushEditing, registerEditFlush, shouldCommitOnBlur, useOutlineStore} =
	await import("../src/client/stores/outline.js");
const {saveAndSyncCommand} = await import("../src/client/save-and-sync.js");

function focusState()
{
	const {editingId, editingCaretOffset, editingHeld, lastEditedId} = useOutlineStore.getState();
	return {
		editingId,
		editingCaretOffset,
		editingHeld,
		lastEditedId,
	};
}

describe("the edited node is the only notion of focus", () =>
{
	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				editingId: null,
				editingCaretOffset: null,
				editingClickPosition: null,
				editingHeld: false,
				lastEditedId: null,
			},
		);
	});

	it("has no separate selection state", () =>
	{
		const state = useOutlineStore.getState();
		expect(
			{
				hasSelectedId: "selectedId" in state,
				hasSelect: "select" in state,
			},
		).toStrictEqual(
			{
				hasSelectedId: false,
				hasSelect: false,
			},
		);
	});

	it("remembers the last edited node after editing stops, for panels that follow it", () =>
	{
		useOutlineStore.getState().startEditing("node-a");
		useOutlineStore.getState().stopEditing();
		expect(focusState()).toStrictEqual(
			{
				editingId: null,
				editingCaretOffset: null,
				editingHeld: false,
				lastEditedId: "node-a",
			},
		);
	});

	it("holds editing at the caret across a structural move, then releases it", () =>
	{
		useOutlineStore.getState().startEditing("node-a");
		useOutlineStore.getState().holdEditing(5);
		const held = focusState();
		useOutlineStore.getState().releaseEditing();
		const released = focusState();
		expect(
			{
				held,
				released,
			},
		).toStrictEqual(
			{
				held:
				{
					editingId: "node-a",
					editingCaretOffset: 5,
					editingHeld: true,
					lastEditedId: "node-a",
				},
				released:
				{
					editingId: "node-a",
					editingCaretOffset: 5,
					editingHeld: false,
					lastEditedId: "node-a",
				},
			},
		);
	});

	it("resumes editing a node at a caret offset", () =>
	{
		useOutlineStore.getState().resumeEditing("node-b", 12);
		expect(focusState()).toStrictEqual(
			{
				editingId: "node-b",
				editingCaretOffset: 12,
				editingHeld: false,
				lastEditedId: "node-b",
			},
		);
	});
});

describe("name and note share one focus", () =>
{
	function nameNoteState()
	{
		const {editingId, editingNoteId, editingCaretOffset, editingClickPosition, lastEditedId} =
			useOutlineStore.getState();
		return {
			editingId,
			editingNoteId,
			editingCaretOffset,
			editingClickPosition,
			lastEditedId,
		};
	}

	beforeEach(() =>
	{
		useOutlineStore.setState(
			{
				editingId: null,
				editingNoteId: null,
				editingCaretOffset: null,
				editingClickPosition: null,
				editingHeld: false,
				lastEditedId: null,
			},
		);
	});

	it("focusNote moves focus from the name to the note", () =>
	{
		useOutlineStore.getState().startEditing("a");
		useOutlineStore.getState().focusNote("a");
		expect(nameNoteState()).toStrictEqual(
			{
				editingId: null,
				editingNoteId: "a",
				editingCaretOffset: null,
				editingClickPosition: null,
				lastEditedId: "a",
			},
		);
	});

	it("focusNote with caret 0 asks the note to put the caret at its start, and defaults to the end", () =>
	{
		useOutlineStore.getState().focusNote("a", 0);
		const atStart = useOutlineStore.getState().editingNoteCaret;
		useOutlineStore.getState().focusNote("b");
		expect(
			{
				atStart,
				byDefault: useOutlineStore.getState().editingNoteCaret,
			},
		).toStrictEqual(
			{
				atStart: 0,
				byDefault: "end",
			},
		);
	});

	it("focusName with caret end moves focus from the note to the end of the name", () =>
	{
		useOutlineStore.getState().focusNote("a");
		useOutlineStore.getState().focusName("a", "end");
		expect(nameNoteState()).toStrictEqual(
			{
				editingId: "a",
				editingNoteId: null,
				editingCaretOffset: Number.MAX_SAFE_INTEGER,
				editingClickPosition: null,
				lastEditedId: "a",
			},
		);
	});

	it("focusName with caret 0 puts the caret at the start of the name", () =>
	{
		useOutlineStore.getState().focusNote("a");
		useOutlineStore.getState().focusName("a", 0);
		expect(nameNoteState()).toStrictEqual(
			{
				editingId: "a",
				editingNoteId: null,
				editingCaretOffset: 0,
				editingClickPosition: null,
				lastEditedId: "a",
			},
		);
	});

	it("requestDatePicker focuses the end of the name and queues the picker for that row until taken", () =>
	{
		useOutlineStore.getState().focusNote("a");
		useOutlineStore.getState().requestDatePicker("a");
		const requested =
		{
			...nameNoteState(),
			datePickerRequest: useOutlineStore.getState().datePickerRequest,
		};
		const firstTake = useOutlineStore.getState().takeDatePickerRequest("a");
		const secondTake = useOutlineStore.getState().takeDatePickerRequest("a");
		expect(
			{
				requested,
				firstTake,
				secondTake,
			},
		).toStrictEqual(
			{
				requested:
				{
					editingId: "a",
					editingNoteId: null,
					editingCaretOffset: Number.MAX_SAFE_INTEGER,
					editingClickPosition: null,
					lastEditedId: "a",
					datePickerRequest:
					{
						id: "a",
					},
				},
				firstTake:
				{
					id: "a",
				},
				secondTake: null,
			},
		);
	});

	it("requestDatePicker with an anchor rect keeps the caret and records the rect until taken", () =>
	{
		useOutlineStore.setState(
			{
				editingId: "a",
				editingNoteId: null,
				editingCaretOffset: 3,
			},
		);
		const rect =
		{
			left: 10,
			right: 40,
			top: 20,
			bottom: 60,
		} as DOMRect;
		useOutlineStore.getState().requestDatePicker("a", rect);
		const requested =
		{
			caret: useOutlineStore.getState().editingCaretOffset,
			id: useOutlineStore.getState().datePickerRequest?.id,
			anchor: useOutlineStore.getState().datePickerAnchor,
		};
		const taken = useOutlineStore.getState().takeDatePickerRequest("a");
		expect(
			{
				requested,
				taken,
				anchorAfter: useOutlineStore.getState().datePickerAnchor,
			},
		).toStrictEqual(
			{
				requested:
				{
					caret: 3,
					id: "a",
					anchor: rect,
				},
				taken:
				{
					id: "a",
				},
				anchorAfter: null,
			},
		);
	});

	it("takeDatePickerRequest ignores another row's request", () =>
	{
		useOutlineStore.getState().requestDatePicker("a");
		expect(
			{
				taken: useOutlineStore.getState().takeDatePickerRequest("b"),
				left: useOutlineStore.getState().datePickerRequest,
			},
		).toStrictEqual(
			{
				taken: null,
				left:
				{
					id: "a",
				},
			},
		);
		useOutlineStore.setState(
			{
				datePickerRequest: null,
			},
		);
	});

	it("requestDatePicker keeps the header text and onSelect for the taking row only", () =>
	{
		const onSelect = () =>
		{
		};
		useOutlineStore.getState().requestDatePicker(
			"a",
			undefined,
			{
				headerText: "Move to Date...",
				onSelect,
			},
		);
		expect(
			{
				other: useOutlineStore.getState().takeDatePickerRequest("b"),
				taken: useOutlineStore.getState().takeDatePickerRequest("a"),
				again: useOutlineStore.getState().takeDatePickerRequest("a"),
			},
		).toStrictEqual(
			{
				other: null,
				taken:
				{
					id: "a",
					headerText: "Move to Date...",
					onSelect,
				},
				again: null,
			},
		);
	});

	it("blurNote clears only its own note's focus", () =>
	{
		useOutlineStore.getState().focusNote("a");
		useOutlineStore.getState().blurNote("b");
		const otherBlurred = nameNoteState().editingNoteId;
		useOutlineStore.getState().blurNote("a");
		expect(
			{
				otherBlurred,
				ownBlurred: nameNoteState().editingNoteId,
			},
		).toStrictEqual(
			{
				otherBlurred: "a",
				ownBlurred: null,
			},
		);
	});
});

describe("shouldCommitOnBlur", () =>
{
	it("commits and stops editing when the blurred node is still the edited one", () =>
	{
		expect(
			shouldCommitOnBlur(
				{
					editingId: "node-a",
					editingHeld: false,
				},
				"node-a",
			),
		).toBe(true);
	});

	it("ignores the blur caused by a structural move that holds editing", () =>
	{
		expect(
			shouldCommitOnBlur(
				{
					editingId: "node-a",
					editingHeld: true,
				},
				"node-a",
			),
		).toBe(false);
	});

	it("ignores the blur after editing was already handed to another node", () =>
	{
		expect(
			shouldCommitOnBlur(
				{
					editingId: "node-b",
					editingHeld: false,
				},
				"node-a",
			),
		).toBe(false);
	});
});

describe("edit flush", () =>
{
	it("calls the registered flush once", () =>
	{
		const flush = vi.fn<() => void>();
		const unregister = registerEditFlush(flush);
		flushEditing();
		unregister();
		expect(flush.mock.calls).toStrictEqual([[]]);
	});

	it("is a no-op after the flush unregisters", () =>
	{
		const flush = vi.fn<() => void>();
		registerEditFlush(flush)();
		flushEditing();
		expect(flush.mock.calls).toStrictEqual([]);
	});

	it("keeps a newer flush when an older one unregisters late", () =>
	{
		const older = vi.fn<() => void>();
		const newer = vi.fn<() => void>();
		const unregisterOlder = registerEditFlush(older);
		const unregisterNewer = registerEditFlush(newer);
		unregisterOlder();
		flushEditing();
		unregisterNewer();
		expect(
			{
				older: older.mock.calls,
				newer: newer.mock.calls,
			},
		).toStrictEqual(
			{
				older: [],
				newer: [[]],
			},
		);
	});
});

describe("saveAndSyncCommand", () =>
{
	it("flushes the edited text, then refetches everything", () =>
	{
		const order: string[] = [];
		const unregister = registerEditFlush(() =>
		{
			order.push("flush");
		});
		saveAndSyncCommand(() =>
		{
			order.push("sync");
		}).execute(
			{
				items: [],
				zoomedId: null,
			},
		);
		unregister();
		expect(order).toStrictEqual(["flush", "sync"]);
	});
});
