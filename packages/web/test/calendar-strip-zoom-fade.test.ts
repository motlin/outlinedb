// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {attachStripZoomFade} from "../src/client/calendar-strip-zoom-fade.js";
import {ZOOMING_CLASS} from "../src/client/zoom-animation.js";

const tick = async () =>
	new Promise<void>((resolve) =>
	{
		setTimeout(resolve, 0);
	});

describe("attachStripZoomFade", () =>
{
	it("fades the strip when a zoom starts, injects the keyframes once, and leaves the animation when it ends", async () =>
	{
		const el = document.createElement("div");
		document.body.append(el);
		const detachA = attachStripZoomFade(el, document);
		const detachB = attachStripZoomFade(el, document);
		const before = el.style.animation;
		document.body.classList.add(ZOOMING_CLASS);
		await tick();
		const during = el.style.animation;
		document.body.classList.remove(ZOOMING_CLASS);
		await tick();
		expect(
			{
				before,
				during,
				after: el.style.animation,
				styles: document.head.querySelectorAll("#wf-calendar-nav-anim").length,
				keyframes: document.getElementById("wf-calendar-nav-anim")?.textContent,
			},
		).toStrictEqual(
			{
				before: "",
				during: "wf-cal-fade 500ms ease-in-out",
				after: "wf-cal-fade 500ms ease-in-out",
				styles: 1,
				keyframes: "@keyframes wf-cal-fade {0%{opacity:1}30%{opacity:0.15}100%{opacity:1}}",
			},
		);
		detachA();
		detachB();
	});
});
