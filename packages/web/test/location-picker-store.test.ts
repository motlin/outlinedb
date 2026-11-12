import {describe, expect, it, vi} from "vite-plus/test";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
		removeItem: () =>
		{
		},
	},
);
vi.stubGlobal("innerWidth", 1272);
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

const {useOutlineStore} = await import("../src/client/stores/outline.js");

const ANCHOR =
{
	x: 10,
	y: 20,
};

describe("openLocationPicker", () =>
{
	it("opens the picker and resolves with the chosen location", async () =>
	{
		const picked = useOutlineStore.getState().openLocationPicker(
			{
				forItemId: "mover",
				headerText: "Move To...",
			},
			ANCHOR,
		);
		expect(useOutlineStore.getState().locationPicker).toStrictEqual(
			{
				forItemId: "mover",
				headerText: "Move To...",
				anchor: ANCHOR,
				returnTo: null,
			},
		);
		useOutlineStore.getState().closeLocationPicker(
			{
				id: "hub",
			},
		);
		await expect(picked).resolves.toStrictEqual(
			{
				id: "hub",
			},
		);
		expect(useOutlineStore.getState().locationPicker).toBeNull();
	});

	it("resolves undefined on close and returns the caret to the edited row", async () =>
	{
		useOutlineStore.setState(
			{
				editingId: "mover",
			},
		);
		const picked = useOutlineStore.getState().openLocationPicker(
			{
				forItemId: "mover",
				headerText: "Move To...",
			},
			ANCHOR,
			{
				nodeId: "mover",
				offset: 3,
			},
		);
		useOutlineStore.setState(
			{
				editingId: null,
			},
		);
		useOutlineStore.getState().closeLocationPicker(undefined);
		await expect(picked).resolves.toBeUndefined();
		const {editingId, editingCaretOffset} = useOutlineStore.getState();
		expect(
			{
				editingId,
				editingCaretOffset,
			},
		).toStrictEqual(
			{
				editingId: "mover",
				editingCaretOffset: 3,
			},
		);
	});

	it("resolves a still-open picker with undefined when another opens", async () =>
	{
		const first = useOutlineStore.getState().openLocationPicker(
			{
				forItemId: "a",
				headerText: "Move To...",
			},
			ANCHOR,
		);
		const second = useOutlineStore.getState().openLocationPicker(
			{
				forItemId: "b",
				headerText: "Move To...",
			},
			ANCHOR,
		);
		await expect(first).resolves.toBeUndefined();
		useOutlineStore.getState().closeLocationPicker(
			{
				createdId: "c1",
			},
		);
		await expect(second).resolves.toStrictEqual(
			{
				createdId: "c1",
			},
		);
	});
});
