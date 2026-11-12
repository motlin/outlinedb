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

const blur = vi.fn<() => void>();
vi.mock("../src/client/caret-dom.js", () => (
{
	editorElement: (nodeId: string) =>
		nodeId === "a"
			?
				{
					blur,
				}
			: null,
	caretTextOffset: () => 3,
}));

const {closeSwitcher} = await import("../src/client/switcher-close.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

describe("closeSwitcher", () =>
{
	it("restores the saved caret on cancel and drops it on navigate", () =>
	{
		const saved =
		{
			nodeId: "a",
			caretOffset: 3,
		};
		expect(
			{
				cancel: closeSwitcher(
					{
						open: true,
						saved,
					},
					"cancel",
				),
				navigate: closeSwitcher(
					{
						open: true,
						saved,
					},
					"navigate",
				),
				nothingSaved: closeSwitcher(
					{
						open: true,
						saved: null,
					},
					"cancel",
				),
			},
		).toStrictEqual(
			{
				cancel:
				{
					open: false,
					restore:
					{
						nodeId: "a",
						caretOffset: 3,
					},
				},
				navigate:
				{
					open: false,
					restore: null,
				},
				nothingSaved:
				{
					open: false,
					restore: null,
				},
			},
		);
	});
});

function jumpState()
{
	const {jumpMenuOpen, jumpMenuReturn, editingId, editingCaretOffset} = useOutlineStore.getState();
	return {
		jumpMenuOpen,
		jumpMenuReturn,
		editingId,
		editingCaretOffset,
	};
}

describe("openJumpMenu / closeJumpMenu", () =>
{
	it("commits the edit on open and returns the caret on cancel", () =>
	{
		blur.mockClear();
		useOutlineStore.setState(
			{
				editingId: "a",
				editingCaretOffset: null,
				jumpMenuOpen: false,
				jumpMenuReturn: null,
			},
		);
		useOutlineStore.getState().openJumpMenu();
		const opened = jumpState();
		useOutlineStore.getState().closeJumpMenu("cancel");
		expect(
			{
				opened,
				closed: jumpState(),
				blurs: blur.mock.calls.length,
			},
		).toStrictEqual(
			{
				opened:
				{
					jumpMenuOpen: true,
					jumpMenuReturn:
					{
						nodeId: "a",
						caretOffset: 3,
					},
					editingId: null,
					editingCaretOffset: null,
				},
				closed:
				{
					jumpMenuOpen: false,
					jumpMenuReturn: null,
					editingId: "a",
					editingCaretOffset: 3,
				},
				blurs: 1,
			},
		);
	});

	it("leaves nothing focused on navigate, and on cancel when nothing was edited", () =>
	{
		useOutlineStore.setState(
			{
				editingId: "a",
				editingCaretOffset: null,
				jumpMenuOpen: false,
				jumpMenuReturn: null,
			},
		);
		useOutlineStore.getState().openJumpMenu();
		useOutlineStore.getState().closeJumpMenu("navigate");
		const navigated = jumpState();
		useOutlineStore.setState(
			{
				editingId: null,
			},
		);
		useOutlineStore.getState().openJumpMenu();
		useOutlineStore.getState().closeJumpMenu("cancel");
		expect(
			{
				navigated,
				cancelled: jumpState(),
			},
		).toStrictEqual(
			{
				navigated:
				{
					jumpMenuOpen: false,
					jumpMenuReturn: null,
					editingId: null,
					editingCaretOffset: null,
				},
				cancelled:
				{
					jumpMenuOpen: false,
					jumpMenuReturn: null,
					editingId: null,
					editingCaretOffset: null,
				},
			},
		);
	});
});
