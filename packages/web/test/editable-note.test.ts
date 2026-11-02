import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it, vi} from "vite-plus/test";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {projectClassName} from "../src/client/components/row-classes.js";
import {addMonolithGuards} from "../src/client/monolith-guards.js";
import {renderDatePills} from "../src/client/date-pills.js";
import {DEFAULT_DATE_SETTINGS} from "../src/client/date-settings.js";
import {EMPTY_PREFERENCES, preferenceKeys} from "../src/client/hooks/use-preferences.js";

const outlineState =
{
	searchQuery: "",
	focusNote: () =>
	{
	},
	focusName: () =>
	{
	},
	blurNote: () =>
	{
	},
};

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector?: (state: typeof outlineState) => unknown) =>
		selector ? selector(outlineState) : outlineState,
	outlineActions: () => outlineState,
	registerEditFlush: () => () =>
	{
	},
	isModalOpen: () => false,
}));
vi.mock("../src/client/hooks/use-nodes.js", async () =>
{
	const {noopMutation} = await import("./helpers/stable-mutation.js");
	return {
		useUpdateNode: () => noopMutation,
	};
});

const {EditableNote} = await import("../src/client/components/editable-note.js");

function render(
	props:
	{
		initialValue: string;
		isFocused?: boolean;
		isMain?: boolean;
	},
	client: QueryClient = new QueryClient(),
): string
{
	return renderToStaticMarkup(
		createElement(
			QueryClientProvider,
			{
				client,
			},
			createElement(
				EditableNote,
				{
					nodeId: "alice",
					isFocused: false,
					...props,
				},
			),
		),
	);
}

describe("EditableNote markup", () =>
{
	it("renders date pills while unfocused and while focused", () =>
	{
		const note = 'due <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>';
		const open =
			'<div class="notes"><div class="notranslate content text-tertiary whitespace-pre-wrap overflow-hidden';
		expect(
			{
				unfocused: render(
					{
						initialValue: note,
					},
				),
				focused: render(
					{
						initialValue: note,
						isFocused: true,
					},
				),
			},
		).toStrictEqual(
			{
				unfocused: `${open}" contentEditable="true"><span class="innerContentContainer">${addMonolithGuards(renderDatePills(note, DEFAULT_DATE_SETTINGS))}</span></div></div>`,
				focused: `${open} active" contentEditable="true"><span class="innerContentContainer">${addMonolithGuards(renderDatePills(note, DEFAULT_DATE_SETTINGS))}</span></div></div>`,
			},
		);
	});

	it("labels date pills with the account's date format from preferences", () =>
	{
		const note = 'due <time startYear="2026" startMonth="10" startDay="1">Thu, Oct 1, 2026</time>';
		const client = new QueryClient();
		const account =
		{
			dateFormat: "YYYY-MM-DD ddd",
			timeFormat: "HH:mm",
			weekStartDay: 1,
		};
		client.setQueryData(
			preferenceKeys.all,
			{
				preferences:
				{
					...EMPTY_PREFERENCES,
					...account,
				},
				available: true,
				error: null,
			},
		);
		expect(
			render(
				{
					initialValue: note,
				},
				client,
			),
		).toBe(
			`<div class="notes"><div class="notranslate content text-tertiary whitespace-pre-wrap overflow-hidden" contentEditable="true"><span class="innerContentContainer">${addMonolithGuards(renderDatePills(note, account))}</span></div></div>`,
		);
	});

	it("renders one always-contenteditable content div", () =>
	{
		expect(
			render(
				{
					initialValue: "Alice\nBob",
				},
			),
		).toBe(
			'<div class="notes"><div class="notranslate content text-tertiary whitespace-pre-wrap overflow-hidden" contentEditable="true"><span class="innerContentContainer">Alice\nBob</span></div></div>',
		);
	});

	it("adds notes--main for the zoom root's note", () =>
	{
		expect(
			render(
				{
					initialValue: "Alice",
					isMain: true,
				},
			),
		).toBe(
			'<div class="notes notes--main"><div class="notranslate content text-tertiary whitespace-pre-wrap overflow-hidden" contentEditable="true"><span class="innerContentContainer">Alice</span></div></div>',
		);
	});

	it("renders an empty content div for an empty note", () =>
	{
		expect(
			render(
				{
					initialValue: "",
				},
			),
		).toBe(
			'<div class="notes"><div class="notranslate content text-tertiary whitespace-pre-wrap overflow-hidden" contentEditable="true"></div></div>',
		);
	});

	it("marks the focused note's content active", () =>
	{
		expect(
			render(
				{
					initialValue: "Alice",
					isFocused: true,
				},
			),
		).toBe(
			'<div class="notes"><div class="notranslate content text-tertiary whitespace-pre-wrap overflow-hidden active" contentEditable="true"><span class="innerContentContainer">Alice</span></div></div>',
		);
	});
});

const LEAF =
{
	hasChildren: false,
	expanded: false,
	completed: false,
	isZoomRoot: false,
	hasMirrors: false,
	highlighted: false,
	addedToSelection: false,
};

describe("noted", () =>
{
	it("is set while an empty note is focused and dropped on blur", () =>
	{
		expect(
			{
				focused: projectClassName(
					{
						...LEAF,
						hasNote: false,
						noteFocused: true,
					},
				)
					.split(" ")
					.includes("noted"),
				blurred: projectClassName(
					{
						...LEAF,
						hasNote: false,
						noteFocused: false,
					},
				)
					.split(" ")
					.includes("noted"),
			},
		).toStrictEqual(
			{
				focused: true,
				blurred: false,
			},
		);
	});
});

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

function normalizeCss(css: string): string
{
	return css
		.replaceAll(/\/\*[\s\S]*?\*\//gu, "")
		.replaceAll(/\s*([{}:;,>()])\s*/gu, "$1")
		.replaceAll(/\s+/gu, " ")
		.replaceAll(";}", "}");
}

describe("note behavior CSS", () =>
{
	const css = normalizeCss(styles);

	it("drops the click-to-expand and editing-chrome rules", () =>
	{
		expect(
			{
				outlineNodeNote: styles.includes(".outline-node-note"),
				expanded: css.includes(".notes>.content.expanded"),
			},
		).toStrictEqual(
			{
				outlineNodeNote: false,
				expanded: false,
			},
		);
	});

	it("contains upstream's note behavior rules", () =>
	{
		const rules = [
			".noted>.notes>.content.active,.noted>.notes>.content.copyOrPasteInProgress,.root>.notes>.content{overflow:visible;display:block;max-height:none;height:auto}",
			'.content:empty:before{content:" ";width:0;display:block}',
			".notes>.content>.innerContentContainer::selection,.notes>.content>.innerContentContainer>*::selection{color:var(--wf-text-secondary);background:var(--wf-background-selected)}",
			".noted>.name>.content{padding-bottom:0}",
			".notes>.content{outline:none}",
		];
		expect(rules.filter((rule) => !css.includes(normalizeCss(rule)))).toStrictEqual([]);
	});

	it("contains the remaining upstream note rules", () =>
	{
		const rules = [
			".children .notes.notes--main{margin-left:-100px;padding-left:100px}",
			".noted>.notes>.content.active,.noted>.notes>.content.copyOrPasteInProgress,.root>.notes>.content{overflow:visible;display:block;max-height:none;height:auto}",
			"@media print{.notes>.content{height:auto !important;display:block !important;-webkit-line-clamp:none !important;max-height:none !important}}",
			".notes .mention .at-sign{font-size:12px}",
			".root>.notes .mention .at-sign{font-size:inherit}",
			".notes .bc-red.bc-red,.notes .bc-orange.bc-orange,.notes .bc-yellow.bc-yellow,.notes .bc-green.bc-green,.notes .bc-blue.bc-blue,.notes .bc-purple.bc-purple,.notes .bc-gray.bc-gray,.notes .bc-teal.bc-teal,.notes .bc-sky.bc-sky,.notes .bc-pink.bc-pink{padding:0}",
		];
		expect(rules.filter((rule) => !css.includes(normalizeCss(rule)))).toStrictEqual([]);
	});
});
