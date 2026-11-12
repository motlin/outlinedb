// @vitest-environment happy-dom
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

const {hideLoadingScreen} = await import("../src/client/loading-screen.js");

const html = readFileSync(join(import.meta.dirname, "../src/client/index.html"), "utf8");

function parsed(): Document
{
	return new DOMParser().parseFromString(html, "text/html");
}

describe("boot loading screen", () =>
{
	beforeEach(() =>
	{
		vi.useFakeTimers();
	});
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("ships upstream's six animated bars before #root", () =>
	{
		const doc = parsed();
		const bars = [...doc.querySelectorAll("#loadingScreen > .b")].map((b) => [
			b.id,
			b.innerHTML.replaceAll(/\s/gu, ""),
		]);
		expect(bars).toStrictEqual(
			[1, 2, 3, 4, 5, 6].map((n) => [`b${n}`, '<divclass="c"></div><divclass="l"></div>']),
		);
		const screen = doc.querySelector("#loadingScreen");
		expect(screen?.nextElementSibling?.id === "root" || screen?.nextElementSibling?.tagName === "SCRIPT").toBe(
			true,
		);
		const css = [...doc.querySelectorAll("style")]
			.map((s) => s.textContent)
			.join("")
			.replaceAll(/\s/gu, "")
			.replaceAll(";}", "}");
		expect(css).toContain("#loadingScreen>.b{position:absolute;left:3px;transform-origin:58px50%}");
		expect(css).toContain(
			"#loadingScreen{position:fixed;width:64px;height:64px;top:50%;left:50%;margin-left:-32px;margin-top:-32px;color:#ddd}",
		);
	});

	it("fades out over 150ms, then removes itself and clears the body background", async () =>
	{
		const doc = parsed();
		doc.body.style.background = "red";
		const screen = doc.querySelector<HTMLElement>("#loadingScreen")!;
		const done = hideLoadingScreen(doc, 150);
		const seen: string[][] = [];
		await vi.advanceTimersByTimeAsync(20);
		seen.push([screen.style.opacity, screen.style.transition, screen.style.display]);
		await vi.advanceTimersByTimeAsync(250);
		await done;
		seen.push([screen.style.opacity, screen.style.transition, screen.style.display]);
		expect(seen).toStrictEqual([
			["0", "opacity 150ms", ""],
			["", "", "none"],
		]);
		expect(doc.body.style.background).toBe("");
	});

	it("does nothing without a loading screen", async () =>
	{
		const doc = new DOMParser().parseFromString("<body></body>", "text/html");
		await expect(hideLoadingScreen(doc)).resolves.toBeUndefined();
	});
});
