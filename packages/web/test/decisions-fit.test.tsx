// @vitest-environment happy-dom
// Renders typical decision cards with the real component, then lays the markup out in headless Chromium at a
// 1440x900 laptop viewport and checks the whole page (header, card, sticky footer) fits without scrolling.
// Needs a Playwright Chromium install, so it skips where there is none.
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Browser} from "playwright-core";
import type {Root} from "react-dom/client";
import type {DecisionPage} from "../src/server/decisions.js";

type DecisionItem = DecisionPage["groups"][number]["items"][number];

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.mock("../src/client/loading-screen.js", () => (
{
	hideLoadingScreenOnce: vi.fn<() => void>(),
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {DecisionPageView} = await import("../src/client/components/decisions-view.js");

const clientDir = join(import.meta.dirname, "../src/client");
const CSS = ["reset.css", "decisions.css"].map((file) => readFileSync(join(clientDir, file), "utf8")).join("\n");

function chromiumPath(): string | undefined
{
	const override = process.env.CHROMIUM_PATH;
	if (override !== undefined)
	{
		return override;
	}
	const binaries = [
		"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
		"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
		"chrome-linux64/chrome",
		"chrome-linux/chrome",
	];
	for (const cache of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")])
	{
		// Any installed revision lays the page out the same way.
		const dirs = existsSync(cache) ? readdirSync(cache).filter((dir) => /^chromium-\d+$/u.test(dir)) : [];
		for (const dir of dirs)
		{
			const found = binaries.map((binary) => join(cache, dir, binary)).find((path) => existsSync(path));
			if (found !== undefined)
			{
				return found;
			}
		}
	}
	return undefined;
}

const MEETING: DecisionItem =
{
	id: "meeting",
	title: "Forward next week's meetings to @Alice and set calendar reminders before the PTO week",
	body: [
		"From Sprint Planning (2026-10-30): Action item explicitly assigned to you; recipient is your direct manager",
		'"Forward next week\'s meetings to Alice and set calendar reminders as needed before being out next week."',
		"Matched: Work > Next > Tasks > Tasks (asap) > 1st > Send PTO-week coverage: run of show for @Alice (Strong: same action; existing task already holds a provenance child. If already done, complete it.)",
	],
	links: [
		{
			label: "Sprint Planning",
			href: "https://workflowy.com/#/aaaaaaaaaaaa",
		},
		{
			label: "Matched task",
			href: "https://workflowy.com/#/bbbbbbbbbbbb",
		},
	],
	options: [
		{
			value: "inbox",
			label: "Add to Work inbox",
		},
		{
			value: "ladder",
			label: "File on Work > Tasks (asap), bottom tier",
			description: "Name another tier in the note",
		},
		{
			value: "file",
			label: "File on existing: Send PTO-week coverage: run of show for @Alice (team meetings to cover",
		},
		{
			value: "complete",
			label: "Done: complete Send PTO-week coverage: run of show for @Alice (team meetings",
		},
		{
			value: "journal",
			label: "Already did it: journal to Work > Calendar",
		},
		{
			value: "skip",
			label: "Skip",
		},
	],
	default: "file",
	answer: null,
};

const JOURNAL: DecisionItem =
{
	id: "journal",
	title: "Oct 29 · Which emoji for the chat with Bob's teachers?",
	body: [
		"Before: Chatted with Bob's teachers Carol and Dave about his progress. He's still not turning in his ELA homework.",
		"After: 🏫 Chatted with @Bob 's teachers Carol and Dave about his progress. He's still not turning in his ELA homework.",
		"👤 Bob's → @Bob 's",
		"✏️ curly apostrophes → straight",
		"⚠️ emoji needed",
	],
	links: [
		{
			label: "Workflowy",
			href: "https://workflowy.com/#/cccccccccccc",
		},
	],
	options: [
		{
			value: "emoji0",
			label: "🏫 school",
		},
		{
			value: "emoji1",
			label: "👩‍🏫 teachers",
		},
		{
			value: "emoji2",
			label: "📝 homework",
		},
		{
			value: "emoji3",
			label: "📚 ELA",
		},
		{
			value: "reject",
			label: "Reject",
			description: "Keep as written",
		},
	],
	default: "emoji0",
	answer: null,
};

function pageOf(item: DecisionItem): DecisionPage
{
	return {
		slug: "fit",
		title: "Daily review · Nov 2",
		groups: [
			{
				heading: "Refine calendar journal",
				items: [item],
			},
		],
		submittedAt: null,
	};
}

/** The page's markup once the component has loaded `item` as its only card. */
async function markupOf(item: DecisionItem): Promise<string>
{
	vi.stubGlobal("fetch", async () => Promise.resolve(Response.json(pageOf(item))));
	const host = document.createElement("div");
	document.body.append(host);
	const root: Root = createRoot(host);
	await act(async () =>
	{
		root.render(
			createElement(
				DecisionPageView,
				{
					slug: "fit",
				},
			),
		);
		for (let index = 0; index < 5; index++)
		{
			await Promise.resolve();
		}
	});
	const html = host.innerHTML;
	await act(async () =>
	{
		root.unmount();
		await Promise.resolve();
	});
	host.remove();
	return html;
}

const executablePath = chromiumPath();

describe.skipIf(executablePath === undefined)("decision card on a 1440x900 laptop", () =>
{
	let browser: Browser | undefined;

	beforeAll(async () =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		const {chromium} = await import("playwright-core");
		browser = await chromium.launch(
			{
				executablePath,
			},
		);
	});

	afterEach(() =>
	{
		vi.unstubAllGlobals();
	});

	afterAll(async () =>
	{
		await browser?.close();
	});

	/** The laid-out page height at 1440x900 with `item` as its card. */
	async function pageHeightOf(item: DecisionItem): Promise<number>
	{
		const html = await markupOf(item);
		const page = await browser!.newPage(
			{
				viewport:
				{
					width: 1440,
					height: 900,
				},
			},
		);
		try
		{
			// The app mounts the route in a full-height flex column, which this host stands in for.
			await page.setContent(
				`<!doctype html><html><head><style>${CSS}</style></head><body><div style="display:flex;flex-direction:column;min-height:100vh">${html}</div></body></html>`,
			);
			return await page.evaluate(() => document.documentElement.scrollHeight);
		}
		finally
		{
			await page.close();
		}
	}

	it.each([MEETING, JOURNAL])("fits a $id card without scrolling", async (item) =>
	{
		await expect(pageHeightOf(item)).resolves.toBeLessThanOrEqual(900);
	});
});
