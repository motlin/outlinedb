import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock} from "./helpers/css-block.js";

const state =
{
	showKeyboardShortcuts: false,
	rightBarCollapsed: true,
	panes: [] as
	{
		id: string;
	}[],
	toggleRightBarCollapsed: () =>
	{
	},
};

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector: (s: typeof state) => unknown) => selector(state),
}));
vi.stubGlobal("innerWidth", 1272);

vi.stubGlobal(
	"navigator",
	{
		platform: "MacIntel",
		userAgent: "",
	},
);
vi.stubGlobal(
	"document",
	{
		cookie: "",
		body:
		{
			style: {},
		},
	},
);

const {RightBar, HOTKEY_ROWS, bodyPaddingRight} = await import("../src/client/components/right-bar.js");
const {registerRightBarPanel} = await import("../src/client/right-bar-panels.js");

// Copied from .llm/upstream-sync/dumps/shortcuts-help-upstream-rows.txt (mac, upstream order)
const UPSTREAM_ROWS:
{
	command: string;
	name: string;
	text: string;
}[] = [
	{
		command: "zoom_in",
		name: "Zoom in",
		text: "⌘.",
	},
	{
		command: "zoom_out",
		name: "Zoom out",
		text: "⌘,",
	},
	{
		command: "navigate_to_today",
		name: "Zoom to Today",
		text: "⌃T",
	},
	{
		command: "expand",
		name: "Expand",
		text: "⌘↓",
	},
	{
		command: "collapse",
		name: "Collapse",
		text: "⌘↑",
	},
	{
		command: "indent",
		name: "Indent",
		text: "⇥",
	},
	{
		command: "outdent",
		name: "Outdent",
		text: "⇧⇥",
	},
	{
		command: "move_up",
		name: "Move up",
		text: "⇧⌘↑",
	},
	{
		command: "move_down",
		name: "Move down",
		text: "⇧⌘↓",
	},
	{
		command: "focus_next_sibling",
		name: "Focus next sibling",
		text: "⌥⌘↓",
	},
	{
		command: "focus_prev_sibling",
		name: "Focus previous sibling",
		text: "⌥⌘↑",
	},
	{
		command: "complete",
		name: "Complete",
		text: "⌘↵",
	},
	{
		command: "duplicate",
		name: "Duplicate",
		text: "⇧⌘D",
	},
	{
		command: "show_export",
		name: "Export",
		text: "⇧⌘E",
	},
	{
		command: "delete",
		name: "Delete",
		text: "⇧⌘⌫",
	},
	{
		command: "focus_or_unfocus_search",
		name: "Search",
		text: "ESC",
	},
	{
		command: "show_or_hide_completed",
		name: "Show/hide completed",
		text: "⌘O",
	},
	{
		command: "star_current_item",
		name: "Star page",
		text: "⇧⌘8",
	},
	{
		command: "navigate_home",
		name: "Navigate home",
		text: "⌘'",
	},
	{
		command: "show_switcher",
		name: "Jump menu",
		text: "⌘K",
	},
	{
		command: "toggle_bold",
		name: "Bold",
		text: "⌘B",
	},
	{
		command: "toggle_italic",
		name: "Italic",
		text: "⌘I",
	},
	{
		command: "toggle_underline",
		name: "Underline",
		text: "⌘U",
	},
	{
		command: "toggle_strikethrough",
		name: "Strikethrough",
		text: "⇧⌘X",
	},
	{
		command: "toggle_code",
		name: "Code",
		text: "⇧⌘C",
	},
	{
		command: "toggle_leftbar",
		name: "Toggle left sidebar",
		text: "⌃L",
	},
	{
		command: "toggle_rightbar",
		name: "Toggle this sidebar",
		text: "⌘/",
	},
	{
		command: "focus_or_open_pane_1",
		name: "Open or focus pane 1–8",
		text: "⌃1–8",
	},
	{
		command: "open_in_pane_1",
		name: "Open in pane 1–8",
		text: "⌃⇧1–8",
	},
	{
		command: "new_pane",
		name: "New pane",
		text: "⌃R",
	},
	{
		command: "close_pane",
		name: "Close pane",
		text: "⌃⌘W",
	},
	{
		command: "mirror",
		name: "Copy mirror(s) to paste",
		text: "⇧⌘M",
	},
	{
		command: "navigate_to_prev_item",
		name: "Jump to previous sibling",
		text: "⇧⌘9",
	},
	{
		command: "navigate_to_next_item",
		name: "Jump to next sibling",
		text: "⇧⌘0",
	},
	{
		command: "toggle_h1",
		name: "Heading 1",
		text: "⌥⌘1",
	},
	{
		command: "toggle_h2",
		name: "Heading 2",
		text: "⌥⌘2",
	},
	{
		command: "toggle_h3",
		name: "Heading 3",
		text: "⌥⌘3",
	},
	{
		command: "toggle_paragraph",
		name: "Paragraph",
		text: "⌥⌘4",
	},
	{
		command: "toggle_code_block",
		name: "Code Block",
		text: "⌥⌘6",
	},
	{
		command: "toggle_quote_block",
		name: "Quote",
		text: "⌥⌘7",
	},
	{
		command: "toggle_bullet",
		name: "Bullet",
		text: "⌥⌘8",
	},
	{
		command: "toggle_todo",
		name: "To do",
		text: "⌥⌘9",
	},
	{
		command: "toggle_numbered",
		name: "Number",
		text: "⌥⌘0",
	},
	{
		command: "mark_read",
		name: "Mark read",
		text: "⇧⌘↵",
	},
	{
		command: "toggle_ai_chat",
		name: "Open/close AI Chat",
		text: "⌃C",
	},
	{
		command: "toggle_ai_item",
		name: "Create AI Node",
		text: "⌥⇧Space",
	},
	{
		command: "previous_unread",
		name: "Jump to previous unread",
		text: "⌥⌃P",
	},
	{
		command: "next_unread",
		name: "Jump to next unread",
		text: "⌥⌃N",
	},
];

// Copied from .llm/upstream-sync/dumps/shortcuts-help-upstream-dom.html
const UPSTREAM_ZOOM_IN_ROW =
	'<div title="zoom_in" class="font-system leading-base py-xs cursor-help"><div class="flex items-center"><div class="flex-grow">Zoom in</div><div class="ml-l min-w-[96px] text-right"><span class="inline-flex items-center justify-center rounded-xs bg-quaternary px-2xs py-3xs text-[11px] font-medium tracking-[0.02em] text-secondary">⌘.</span></div></div></div>';

function render(
	showKeyboardShortcuts: boolean,
	rightBarCollapsed: boolean,
	panes:
	{
		id: string;
	}[] = [],
): string
{
	Object.assign(
		state,
		{
			showKeyboardShortcuts,
			rightBarCollapsed,
			panes,
		},
	);
	return renderToStaticMarkup(createElement(RightBar));
}

function panelStyle(html: string): string
{
	return /<div class="fixed top-(?:3xl|0) right-sal[^"]*" style="([^"]*)"/u.exec(html)?.[1] ?? "";
}

function stripText(html: string): string
{
	return /hover:bg-quaternary">([^<]*)<\/div>/u.exec(html)?.[1] ?? "";
}

function rowHtml(html: string, command: string): string
{
	return new RegExp(`<div title="${command}".*?</div></div></div>`, "u").exec(html)?.[0] ?? "";
}

describe("RightBar", () =>
{
	it("renders an empty root when the setting is off", () =>
	{
		expect(render(false, false)).toBe(
			'<div class="right-bar inline-flex fixed top-3xl right-0" style="z-index:99"></div>',
		);
	});

	it("slides the collapsed panel off screen with a left arrow strip", () =>
	{
		const html = render(true, true);
		expect(
			{
				style: panelStyle(html),
				strip: stripText(html),
			},
		).toStrictEqual(
			{
				style: "width:400px;transform:translateX(calc(100% - var(--wf-space-l)));z-index:99",
				strip: "←",
			},
		);
	});

	it("renders the expanded panel with every upstream row in order", () =>
	{
		const html = render(true, false);
		expect(
			{
				style: panelStyle(html),
				strip: stripText(html),
				titles: [...html.matchAll(/<div title="([^"]*)"/gu)].map((match) => match[1]),
			},
		).toStrictEqual(
			{
				style: "width:400px;z-index:99",
				strip: "→",
				titles: UPSTREAM_ROWS.map((row) => row.command),
			},
		);
	});

	it("pins the panel to top-0 while panes are open and top-3xl otherwise", () =>
	{
		const panelClass = (html: string): string | undefined =>
			/<div class="(fixed top-[^"]*)" style/u.exec(html)?.[1];
		const tail =
			"right-sal bottom-sal\n        text-xs bg-primary text-secondary transition-transform duration-200 ease-base print:hidden";
		expect([
			panelClass(
				render(true, false, [
					{
						id: "p1",
					},
				]),
			),
			panelClass(render(true, false, [])),
		]).toStrictEqual([`fixed top-0 ${tail}`, `fixed top-3xl ${tail}`]);
	});

	it("renders the zoom_in row byte for byte like upstream", () =>
	{
		expect(rowHtml(render(true, false), "zoom_in")).toBe(UPSTREAM_ZOOM_IN_ROW);
	});

	it("renders the pane range chip", () =>
	{
		expect(/<span[^>]*>([^<]*)<\/span>/u.exec(rowHtml(render(true, false), "focus_or_open_pane_1"))?.[1]).toBe(
			"⌃1–8",
		);
	});

	it("matches every upstream name and chip", () =>
	{
		const html = render(true, false);
		expect(
			HOTKEY_ROWS.map((row) => (
			{
				command: row.command,
				name: row.name,
				text: (/<span[^>]*>([^<]*)<\/span>/u.exec(rowHtml(html, row.command))?.[1] ?? "").replace(
					"&#x27;",
					"'",
				),
			})),
		).toStrictEqual(UPSTREAM_ROWS);
	});
});

describe("right bar panel registry", () =>
{
	const PILL_CLASS = "cursor-pointer py-2xs px-ml rounded-[16px]";
	const ACTIVE = `${PILL_CLASS} !text-on-color !bg-tint`;
	const INACTIVE = `${PILL_CLASS} !text-on-surface !bg-transparent`;

	function pills(html: string):
	{
		class: string;
		text: string;
	}[]
	{
		return [...html.matchAll(/<span class="(cursor-pointer[^"]*)">([^<]*)<\/span>/gu)].map((match) => (
		{
			class: match[1],
			text: match[2],
		}));
	}

	function withTwoPanels(cookie: string):
	{
		class: string;
		text: string;
	}[]
	{
		const first = registerRightBarPanel(
			{
				title: "First",
				element: () => null,
			},
		);
		const second = registerRightBarPanel(
			{
				title: "Second",
				element: () => null,
			},
		);
		document.cookie = cookie;
		try
		{
			return pills(render(true, false));
		}
		finally
		{
			first();
			second();
			document.cookie = "";
		}
	}

	it("activates the first panel without a cookie", () =>
	{
		expect(withTwoPanels("")).toStrictEqual([
			{
				class: ACTIVE,
				text: "Hotkeys",
			},
			{
				class: INACTIVE,
				text: "First",
			},
			{
				class: INACTIVE,
				text: "Second",
			},
		]);
	});

	it("activates the panel named by the right-bar-last cookie", () =>
	{
		expect(withTwoPanels("right-bar-last=Second")).toStrictEqual([
			{
				class: INACTIVE,
				text: "Hotkeys",
			},
			{
				class: INACTIVE,
				text: "First",
			},
			{
				class: ACTIVE,
				text: "Second",
			},
		]);
	});

	it("falls back to the first panel for an unknown cookie value", () =>
	{
		expect(withTwoPanels("right-bar-last=Nope")).toStrictEqual([
			{
				class: ACTIVE,
				text: "Hotkeys",
			},
			{
				class: INACTIVE,
				text: "First",
			},
			{
				class: INACTIVE,
				text: "Second",
			},
		]);
	});

	it("keeps the single-panel pill markup upstream's", () =>
	{
		expect(pills(render(true, false))).toStrictEqual([
			{
				class: ACTIVE,
				text: "Hotkeys",
			},
		]);
	});
});

describe("bodyPaddingRight", () =>
{
	it("pads the body by the hidden, collapsed, and expanded bar widths", () =>
	{
		expect([
			bodyPaddingRight(
				{
					show: false,
					collapsed: false,
					width: 400,
				},
			),
			bodyPaddingRight(
				{
					show: true,
					collapsed: true,
					width: 400,
				},
			),
			bodyPaddingRight(
				{
					show: true,
					collapsed: false,
					width: 400,
				},
			),
		]).toStrictEqual([0, 16, 400]);
	});
});

describe("page scroll container", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
	const app = readFileSync(fileURLToPath(new URL("../src/client/app.tsx", import.meta.url)), "utf8");

	it("lets the document scroll like upstream's .pageContainer, so the page scrollbar sits at the window edge past the padded-out hotkeys panel, and contains the outline view's 72px top margin so it cannot collapse through and leave a short page 72px taller than the viewport", () =>
	{
		expect(
			{
				css: cssBlock(styles, ".outline-container"),
				classes: /"outline-container[^"]*"/u.exec(app)?.[0],
			},
		).toStrictEqual(
			{
				css:
				{
					"min-height": "100vh",
					display: "flow-root",
				},
				classes: '"outline-container"',
			},
		);
	});

	it("always shows the page scrollbar, so a body-portaled flyout that grows the document, like the slash menu, cannot toggle the scrollbar and re-wrap row text", () =>
	{
		expect(cssBlock(styles, "html")).toStrictEqual(
			{
				"overflow-y": "scroll",
			},
		);
	});
});
