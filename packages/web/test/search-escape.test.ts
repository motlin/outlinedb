// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {useOutlineStore} from "../src/client/stores/outline.js";
import {escapeAction} from "../src/client/search-escape.js";

describe("escapeAction", () =>
{
	it("cancels a committed or typed search, blurs an empty focused box, else focuses search", () =>
	{
		expect([
			escapeAction(
				{
					searchQuery: "a",
					searchInput: "",
					inputFocused: false,
				},
			),
			escapeAction(
				{
					searchQuery: "",
					searchInput: "a",
					inputFocused: true,
				},
			),
			escapeAction(
				{
					searchQuery: "",
					searchInput: "a",
					inputFocused: false,
				},
			),
			escapeAction(
				{
					searchQuery: "",
					searchInput: "",
					inputFocused: true,
				},
			),
			escapeAction(
				{
					searchQuery: "",
					searchInput: "",
					inputFocused: false,
				},
			),
		]).toStrictEqual(["cancel", "cancel", "cancel", "blur", "focus"]);
	});
});

describe("blurSearch", () =>
{
	it("returns to the note at its caret when the search was entered from a note", () =>
	{
		useOutlineStore.setState(
			{
				editingId: null,
				editingNoteId: null,
			},
		);
		useOutlineStore.getState().focusSearch(
			{
				nodeId: "a",
				caretOffset: 5,
				field: "note",
			},
		);
		useOutlineStore.getState().blurSearch();
		const {editingNoteId, editingId, editingNoteCaret} = useOutlineStore.getState();
		expect(
			{
				editingNoteId,
				editingId,
				editingNoteCaret,
			},
		).toStrictEqual(
			{
				editingNoteId: "a",
				editingId: null,
				editingNoteCaret: 5,
			},
		);
	});

	it("returns to the name when the search was entered from a name", () =>
	{
		useOutlineStore.setState(
			{
				editingId: null,
				editingNoteId: null,
			},
		);
		useOutlineStore.getState().focusSearch(
			{
				nodeId: "a",
				caretOffset: 5,
				field: "name",
			},
		);
		useOutlineStore.getState().blurSearch();
		const {editingNoteId, editingId} = useOutlineStore.getState();
		expect(
			{
				editingNoteId,
				editingId,
			},
		).toStrictEqual(
			{
				editingNoteId: null,
				editingId: "a",
			},
		);
	});
});
