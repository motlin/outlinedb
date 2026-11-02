import {afterEach, describe, expect, it} from "vite-plus/test";
import {planBlockPrefix} from "../src/client/block-prefix.js";
import {isBacklinksSectionVisible} from "../src/client/backlinks.js";
import {previewKind} from "../src/client/components/file-preview-kind.js";
import {resolveLayoutMode} from "../src/client/components/layout-mode.js";
import {DEFAULT_FEATURES, setAccountFeatures} from "../src/client/features.js";
import {highlightSearchMatches} from "../src/client/highlight-html.js";
import {availableItemTypes} from "../src/client/layout-types.js";
import type {ItemTypeContext} from "../src/client/layout-types.js";
import {paneCommands} from "../src/client/pane-commands.js";
import type {PaneCommandStore} from "../src/client/pane-commands.js";
import {buildPasteLines} from "../src/client/paste/apply.js";
import {planSlashOpen} from "../src/client/slash-trigger.js";
import type {BacklinksResponse, NodeAttachment} from "../src/node-types.js";

/** The measured account dict with `codename` switched off, the way a disabled flag is absent from the dict. */
function without(codename: string): void
{
	setAccountFeatures(Object.fromEntries(Object.entries(DEFAULT_FEATURES).filter(([name]) => name !== codename)));
}

afterEach(() =>
{
	setAccountFeatures(null);
});

const NORMAL: ItemTypeContext =
{
	isRoot: false,
	isMainDocumentRoot: false,
	readOnly: false,
	isTableCell: false,
};

function keys(): string[]
{
	return availableItemTypes(NORMAL, false).map((type) => type.key);
}

describe("table flag", () =>
{
	it("hides the Table type when off and keeps it by default", () =>
	{
		const defaults = keys().includes("table");
		without("table");
		expect(
			{
				defaults,
				off: keys().includes("table"),
			},
		).toStrictEqual(
			{
				defaults: true,
				off: false,
			},
		);
	});
});

describe("numbered_list flag", () =>
{
	it("hides the Number type and the 1. transform when off, keeps both by default", () =>
	{
		const plan = () =>
			planBlockPrefix(
				{
					before: "1. ",
					after: "",
					layoutMode: null,
				},
			);
		const defaults =
		{
			type: keys().includes("numbered"),
			plan: plan()?.layoutMode,
		};
		without("numbered_list");
		expect(
			{
				defaults,
				off:
				{
					type: keys().includes("numbered"),
					plan: plan(),
				},
			},
		).toStrictEqual(
			{
				defaults:
				{
					type: true,
					plan: "numbered",
				},
				off:
				{
					type: false,
					plan: null,
				},
			},
		);
	});
});

describe("check (no longer a flag)", () =>
{
	it("keeps the checkmark class even when the account dict lacks check", () =>
	{
		setAccountFeatures({});
		expect(resolveLayoutMode("todo", false).projectClasses).toStrictEqual(["checkmark"]);
	});
});

describe("bdl flag", () =>
{
	it("hides the Backlinks section when off", () =>
	{
		const backlinks =
		{
			rootId: "root",
			items: [
				{
					node:
					{
						completedAt: null,
					},
				},
			],
		} as unknown as BacklinksResponse;
		const defaults = isBacklinksSectionVisible(backlinks, true);
		without("bdl");
		expect(
			{
				defaults,
				off: isBacklinksSectionVisible(backlinks, true),
			},
		).toStrictEqual(
			{
				defaults: true,
				off: false,
			},
		);
	});
});

describe("nested_search flag", () =>
{
	it("treats > as text when off", () =>
	{
		const html = "alpha beta";
		const defaults = highlightSearchMatches(html, "alpha > beta");
		without("nested_search");
		const off = highlightSearchMatches(html, "alpha > beta");
		expect(off).not.toBe(defaults);
		expect(defaults).not.toContain("alpha</");
	});
});

describe("slash-command (no longer a flag)", () =>
{
	it("opens the slash menu even when the account dict lacks slash-command", () =>
	{
		setAccountFeatures({});
		expect(planSlashOpen("/", 0)).toStrictEqual(
			{
				start: 0,
				end: 1,
			},
		);
	});
});

describe("side_pane flag", () =>
{
	it("makes new_pane do nothing when off", () =>
	{
		const opened: unknown[] = [];
		const store =
		{
			getState: () => (
			{
				panes: [],
				activePaneId: "main",
				zoomedNodeId: "z",
				openPane: (...args: unknown[]) =>
				{
					opened.push(args);
					return "NEW";
				},
			}),
		} as unknown as PaneCommandStore;
		const run = () =>
		{
			(
				paneCommands(store).new_pane as
				{
					execute: (ctx: unknown) => void;
				}
			).execute({});
		};
		run();
		const defaults = opened.length;
		without("side_pane");
		run();
		expect(
			{
				defaults,
				after: opened.length,
			},
		).toStrictEqual(
			{
				defaults: 1,
				after: 1,
			},
		);
	});
});

describe("markdown_pasting flag", () =>
{
	it("pastes markdown literally when off", () =>
	{
		const text = "# Head";
		const summary = () =>
			buildPasteLines(
				{
					text,
				},
			).map((line) => [line.name, line.layoutMode]);
		const defaults = summary();
		without("markdown_pasting");
		expect(
			{
				defaults,
				off: summary(),
			},
		).toStrictEqual(
			{
				defaults: [["Head", "h1"]],
				off: [["# Head", undefined]],
			},
		);
	});
});

describe("beta_redirect flag", () =>
{
	it("falls back to a download for video previews when off", () =>
	{
		const video =
		{
			fileType: "video/mp4",
			isDeleted: false,
		} as NodeAttachment;
		const defaults = previewKind(video);
		without("beta_redirect");
		expect(
			{
				defaults,
				off: previewKind(video),
			},
		).toStrictEqual(
			{
				defaults: "video",
				off: "download",
			},
		);
	});
});
