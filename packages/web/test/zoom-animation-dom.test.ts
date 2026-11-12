// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {runZoomAnimation} from "../src/client/zoom-animation.js";

interface Box
{
	left: number;
	top: number;
	width?: number;
}

/** Make `el` report `box` as its bounding rect. */
function place(el: Element, {left, top, width = 400}: Box): void
{
	vi.spyOn(el, "getBoundingClientRect").mockReturnValue(
		{
			left,
			top,
			x: left,
			y: top,
			width,
			height: 20,
			right: left + width,
			bottom: top + 20,
			toJSON: () => ({}),
		},
	);
}

function row(id: string, text: string, rowBox: Box, nameBox: Box, children: HTMLElement[] = []): HTMLElement
{
	const el = document.createElement("div");
	el.className = "project";
	const name = document.createElement("div");
	name.className = "name";
	const bullet = document.createElement("a");
	bullet.className = "bullet";
	bullet.dataset.itemId = id;
	const content = document.createElement("div");
	content.className = "content";
	content.textContent = text;
	content.style.fontSize = "16px";
	name.append(bullet, content);
	const kids = document.createElement("div");
	kids.className = "children";
	kids.append(...children);
	el.append(name, kids);
	place(el, rowBox);
	place(name, nameBox);
	place(
		content,
		{
			left: rowBox.left + 24,
			top: rowBox.top,
		},
	);
	return el;
}

/** Each animated element's label and its two keyframes. */
function recordAnimations(): string[]
{
	const seen: string[] = [];
	vi.spyOn(Element.prototype, "animate").mockImplementation(function animate(this: Element, keyframes)
	{
		const frames = keyframes as Keyframe[];
		const label =
			this.parentElement === document.body
				? `clone ${(this as HTMLElement).style.fontSize}`
				: this.textContent.slice(0, 8);
		seen.push(`${label}: ${frames.map((k) => `${String(k.opacity)} ${String(k.transform)}`).join(" -> ")}`);
		return {
			finished: Promise.resolve(),
			cancel: () =>
			{
			},
		} as unknown as Animation;
	});
	return seen;
}

afterEach(() =>
{
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("runZoomAnimation", () =>
{
	it("zooming in slides the title, row, siblings and children by the rows' offset, whatever the .name boxes span", async () =>
	{
		const child = row(
			"c",
			"Child",
			{
				left: 116,
				top: 280,
			},
			{
				left: -384,
				top: 280,
			},
		);
		const moving = row(
			"m",
			"Moving",
			{
				left: 80,
				top: 252,
			},
			{
				left: -420,
				top: 252,
			},
			[child],
		);
		const sibling = row(
			"s",
			"Sibling",
			{
				left: 80,
				top: 140,
			},
			{
				left: -420,
				top: 140,
			},
		);
		const title = row(
			"t",
			"Title",
			{
				left: 80,
				top: 96,
			},
			{
				left: -20,
				top: 96,
			},
		);
		title.classList.add("root");
		title.querySelector<HTMLElement>(":scope > .name > .content")!.style.fontSize = "27px";
		title.querySelector(":scope > .children")!.append(sibling, moving);
		document.body.append(title);
		const seen = recordAnimations();

		await runZoomAnimation(false, "m");

		const away = "0 translate(-36px, -136px)";
		expect(seen).toStrictEqual([
			"clone 16px: 1 none -> 0 translate(0px, -156px) scale(1.6875)",
			"clone 27px: 1 scale(0.5925925925925926) -> 1 translate(0px, -156px)",
			`Title: 1 none -> ${away}`,
			`Moving: 1 none -> ${away}`,
			"Child: 1 none -> 1 translate(-36px, -136px)",
			`Sibling: 1 none -> ${away}`,
		]);
		expect(document.body.children).toHaveLength(1);
	});
});
