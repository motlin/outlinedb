import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";

const FILES = [
	"components/outline-tree.tsx",
	"components/expand-arrow.tsx",
	"components/dialog-shell.tsx",
	"components/flyout/popover-box.ts",
	"components/right-bar.tsx",
	"components/offline-notice.tsx",
	"components/gui-banner.tsx",
	"components/search-count-indicator.tsx",
	"components/side-pane.tsx",
];

describe("print:hidden on floating chrome", () =>
{
	it("is present in every chrome surface's class string", () =>
	{
		const pairs = FILES.map((file) => [
			file,
			readFileSync(new URL(`../src/client/${file}`, import.meta.url), "utf8").includes("print:hidden"),
		]);
		expect(pairs).toStrictEqual(FILES.map((file) => [file, true]));
	});

	it("keeps export, settings, link insert, shortcuts and jump dialogs inside the print-hidden backdrop", () =>
	{
		const unshelled = ["export-dialog", "jump-menu", "alert-dialog", "mirrors-dialog"].filter(
			(name) =>
				readFileSync(new URL(`../src/client/components/${name}.tsx`, import.meta.url), "utf8").match(
					/DialogShell|BACKDROP_CLASS/u,
				) === null,
		);
		expect(unshelled).toStrictEqual([]);
	});
});
