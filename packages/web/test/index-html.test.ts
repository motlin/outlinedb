import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";

describe("index html viewport", () => {
	describe("index.html viewport", () => {
		it("pins the viewport and covers the notch", () => {
			const html = readFileSync(fileURLToPath(new URL("../src/client/index.html", import.meta.url)), "utf8");
			expect(/<meta\s+name="viewport"\s+content="([^"]*)"/u.exec(html)?.[1]).toBe(
				"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0, viewport-fit=cover",
			);
		});
	});
});

describe("index html", () => {
	const html = readFileSync(new URL("../src/client/index.html", import.meta.url), "utf8");

	describe("index.html", () => {
		it("matches upstream's viewport meta and desktop body", () => {
			expect({
				viewport: /<meta\s+name="viewport"\s+content="([^"]*)"/u.exec(html)?.[1],
				desktopBody: html.includes('<body class="is-desktop font-system">'),
			}).toStrictEqual({
				viewport:
					"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0, viewport-fit=cover",
				desktopBody: true,
			});
		});
	});
});
