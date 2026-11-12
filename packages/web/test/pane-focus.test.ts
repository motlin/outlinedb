// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {paneFocusTarget, requestPaneFocus} from "../src/client/pane-focus.js";

function pane(id: string, html: string): HTMLElement
{
	const element = document.createElement("div");
	element.dataset.paneId = id;
	element.innerHTML = html;
	document.body.append(element);
	return element;
}

const zoomed =
	'<div class="project root"><div class="name"><div class="content"><span class="innerContentContainer" data-node-id="T">T</span></div></div></div><div class="project"><div class="name"><div class="content"><span class="innerContentContainer" data-node-id="C">child</span></div></div></div>';
const home =
	'<div class="project"><div class="name"><div class="content"><span class="innerContentContainer" data-node-id="R1">first</span></div></div></div>';

afterEach(() =>
{
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("paneFocusTarget", () =>
{
	it("is the zoom title's content when zoomed", () =>
	{
		const root = pane("p", zoomed);
		expect(paneFocusTarget(root)?.querySelector("[data-node-id]")?.getAttribute("data-node-id")).toBe("T");
	});

	it("is the first row's content at Home", () =>
	{
		const root = pane("p", home);
		expect(paneFocusTarget(root)?.querySelector("[data-node-id]")?.getAttribute("data-node-id")).toBe("R1");
	});

	it("is null for a pane with no rows", () =>
	{
		expect(paneFocusTarget(pane("p", ""))).toBeNull();
	});
});

describe("requestPaneFocus", () =>
{
	let frames: (() => void)[];
	const runFrame = () =>
	{
		const pending = frames;
		frames = [];
		for (const frame of pending)
		{
			frame();
		}
	};
	beforeEach(() =>
	{
		frames = [];
		vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
	});

	it("puts the caret on the pane's title at offset 0 and reveals the pane on the next frame", () =>
	{
		const root = pane("p", zoomed);
		const reveal = vi.fn<(options: ScrollIntoViewOptions) => void>();
		root.scrollIntoView = reveal;
		const resume = vi.fn<(nodeId: string, offset: number) => void>();
		requestPaneFocus(
			{
				paneId: "p",
				zoomedId: "T",
				reveal: true,
			},
			{
				resumeEditing: resume,
			},
		);
		expect(resume).not.toHaveBeenCalled();
		runFrame();
		expect(
			{
				resume: resume.mock.calls,
				reveal: reveal.mock.calls,
			},
		).toStrictEqual(
			{
				resume: [["T", 0]],
				reveal: [
					[
						{
							block: "nearest",
							inline: "nearest",
						},
					],
				],
			},
		);
	});

	it("does not reveal the pane after a close", () =>
	{
		const root = pane("p", zoomed);
		const reveal = vi.fn<(options: ScrollIntoViewOptions) => void>();
		root.scrollIntoView = reveal;
		requestPaneFocus(
			{
				paneId: "p",
				zoomedId: "T",
				reveal: false,
			},
			{
				resumeEditing: vi.fn<(nodeId: string, offset: number) => void>(),
			},
		);
		runFrame();
		expect(reveal).not.toHaveBeenCalled();
	});

	it("waits for the pane to render the requested zoom", () =>
	{
		const root = pane("p", home);
		const resume = vi.fn<(nodeId: string, offset: number) => void>();
		requestPaneFocus(
			{
				paneId: "p",
				zoomedId: "T",
				reveal: true,
			},
			{
				resumeEditing: resume,
			},
		);
		runFrame();
		expect(resume).not.toHaveBeenCalled();
		root.innerHTML = zoomed;
		runFrame();
		expect(resume.mock.calls).toStrictEqual([["T", 0]]);
	});

	it("gives up after 60 frames when the pane never appears", () =>
	{
		const resume = vi.fn<(nodeId: string, offset: number) => void>();
		requestPaneFocus(
			{
				paneId: "missing",
				zoomedId: null,
				reveal: true,
			},
			{
				resumeEditing: resume,
			},
		);
		for (let frame = 0; frame < 80; frame++)
		{
			runFrame();
		}
		expect(
			{
				resume: resume.mock.calls,
				pending: frames.length,
			},
		).toStrictEqual(
			{
				resume: [],
				pending: 0,
			},
		);
	});

	it("lets a newer request cancel a pending one", () =>
	{
		pane("a", home);
		pane("b", zoomed);
		const resume = vi.fn<(nodeId: string, offset: number) => void>();
		requestPaneFocus(
			{
				paneId: "a",
				zoomedId: null,
				reveal: true,
			},
			{
				resumeEditing: resume,
			},
		);
		requestPaneFocus(
			{
				paneId: "b",
				zoomedId: "T",
				reveal: true,
			},
			{
				resumeEditing: resume,
			},
		);
		runFrame();
		expect(resume.mock.calls).toStrictEqual([["T", 0]]);
	});
});
