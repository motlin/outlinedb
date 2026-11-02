import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";

const css = readFileSync(new URL("../src/client/zen-mode.css", import.meta.url), "utf8").replaceAll(/\s+/gu, " ");

describe("zen-mode.css", () =>
{
	it("hides the header but for a 6px strip and a hover zone", () =>
	{
		expect(css).toContain(
			"body.zen-mode .wf-header.header { opacity: 0; transform: translateY(calc(-100% + 6px)); }",
		);
		expect(css).toContain(
			'body.zen-mode .wf-header.header::before { content: ""; position: absolute; left: 0; right: 0; top: calc(100% - 6px); height: calc(var(--wf-header-height) - 6px); }',
		);
		expect(css).toContain(
			"body.zen-mode .wf-header.header:hover, body.zen-mode .wf-header.header:focus-within { opacity: 1; transform: translateY(0); }",
		);
	});

	it("dims every row but the current one", () =>
	{
		expect(css).toContain(
			"body.zen-mode .project > .name, body.zen-mode .project > .notes { transition: opacity 120ms ease, filter 120ms ease, color 120ms ease; }",
		);
		expect(css).toContain(
			"body.zen-mode.zen-mode--focused .project:not(.zen-mode-current) > .name, body.zen-mode.zen-mode--focused .project:not(.zen-mode-current) > .notes { color: var(--wf-text-secondary); opacity: 0.62; filter: saturate(0.25); }",
		);
	});

	it("leaves the header transition out, as upstream's undefined variable makes it instant", () =>
	{
		expect(css.includes("160ms")).toBe(false);
	});

	it("is imported by the app", () =>
	{
		expect(readFileSync(new URL("../src/client/app.tsx", import.meta.url), "utf8")).toContain(
			'import "./zen-mode.css";',
		);
	});
});
