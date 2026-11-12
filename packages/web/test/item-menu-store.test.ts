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

describe("item menu store", () =>
{
	it("tracks which row's item menu is open, and a stale close does not clear a newer open", () =>
	{
		const {setItemMenuOpen} = useOutlineStore.getState();
		const ids: (string | null)[] = [useOutlineStore.getState().itemMenuOpenId];
		setItemMenuOpen("alice", true);
		ids.push(useOutlineStore.getState().itemMenuOpenId);
		setItemMenuOpen("bob", true);
		setItemMenuOpen("alice", false);
		ids.push(useOutlineStore.getState().itemMenuOpenId);
		setItemMenuOpen("bob", false);
		ids.push(useOutlineStore.getState().itemMenuOpenId);
		expect(ids).toStrictEqual([null, "alice", "bob", null]);
	});
});
