// @vitest-environment happy-dom
import {beforeEach, describe, expect, it} from "vite-plus/test";
import {useOutlineStore} from "../src/client/stores/outline.js";

const caretState = ():
{
	offset: number | null;
	end: number | null;
	reversed: boolean;
} =>
{
	const {editingCaretOffset, editingCaretEnd, editingCaretReversed} = useOutlineStore.getState();
	return {
		offset: editingCaretOffset,
		end: editingCaretEnd,
		reversed: editingCaretReversed,
	};
};

beforeEach(() =>
{
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
});

describe("editing caret range", () =>
{
	it("holdEditing keeps a selection range and its direction", () =>
	{
		useOutlineStore.getState().holdEditing(1, 3, true);

		expect(caretState()).toStrictEqual(
			{
				offset: 1,
				end: 3,
				reversed: true,
			},
		);
	});

	it("holdEditing with a bare offset holds a collapsed caret", () =>
	{
		useOutlineStore.getState().holdEditing(0, 2);
		useOutlineStore.getState().holdEditing(5);

		expect(caretState()).toStrictEqual(
			{
				offset: 5,
				end: null,
				reversed: false,
			},
		);
	});

	it("resumeEditing restores a range", () =>
	{
		useOutlineStore.getState().resumeEditing(
			"a",
			3,
			{
				end: 7,
			},
		);

		expect(caretState()).toStrictEqual(
			{
				offset: 3,
				end: 7,
				reversed: false,
			},
		);
	});

	it("moving the caret elsewhere drops the range", () =>
	{
		useOutlineStore.getState().resumeEditing(
			"a",
			3,
			{
				end: 7,
			},
		);
		useOutlineStore.getState().focusName("a", "end");

		expect(caretState().end).toBeNull();
	});
});
