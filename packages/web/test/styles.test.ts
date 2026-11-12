import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock, hasSelector} from "./helpers/css-block.js";
import {pageClassName} from "../src/client/page-style.js";

describe("styles contract", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

	describe("flyout surface styles", () =>
	{
		it("gives the portaled flyout body line-height 1 and the default content-box", () =>
		{
			expect(cssBlock(styles, ".wf-menu.flyout")).toStrictEqual(
				{
					"line-height": "1",
				},
			);
		});

		it("drops the location picker's own line-height restore, now inherited from the flyout rule", () =>
		{
			expect(hasSelector(styles, /min-w-\\\[480px\\\]\s*>\s*\.wf-menu\.flyout/u)).toBe(false);
		});
	});
});

describe("styles guard", () =>
{
	const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");
	const uncommented = styles.replaceAll(/\/\*[\s\S]*?\*\//gu, "");

	function declarationsFor(selectorPattern: RegExp): string[]
	{
		return [...uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
			.filter((match) => selectorPattern.test(match[1]))
			.map((match) => match[2].trim());
	}

	describe("breadcrumb styles guard", () =>
	{
		it("drops the old local breadcrumb rules", () =>
		{
			expect(
				hasSelector(
					styles,
					/\.breadcrumb-(back|home-icon|path-segment|separator|current)\b|\.breadcrumbs-loading|\.top-bar \.breadcrumbs/u,
				),
			).toBe(false);
		});

		it("has no top-level .breadcrumbs rule", () =>
		{
			expect(hasSelector(styles, /^\.breadcrumbs\s*\{/mu)).toBe(false);
			expect(hasSelector(styles, /^\s*\.breadcrumbs\s*$/mu)).toBe(false);
		});

		it("never sets opacity on .breadcrumb-item", () =>
		{
			expect(
				declarationsFor(/\.breadcrumb-item\b/u).filter((body) => /(^|[;\s])opacity\s*:/u.test(body)),
			).toStrictEqual([]);
		});

		it("keeps only the header color rule, the backlink crumb anchor reset, the hover underline and the flyout line-height", () =>
		{
			expect(declarationsFor(/\.breadcrumbs?\b|\.breadcrumb-item\b|\.breadcrumb-overflow-menu\b/u)).toStrictEqual(
				[
					"color: var(--wf-text-primary) !important;",
					"line-height: 1;",
					"text-decoration: none;\n\tcolor: inherit;\n\tcursor: pointer;",
					"text-decoration: underline;",
				],
			);
		});

		it("sets line-height 1 on the overflow menu, not on its crumbs", () =>
		{
			expect(hasSelector(styles, /\.breadcrumb-overflow-menu \.breadcrumb-item\s*\{/u)).toBe(false);
			expect(declarationsFor(/\.breadcrumb-overflow-menu\b/u)).toStrictEqual(["line-height: 1;"]);
		});

		it("underlines in-outline crumbs on hover without changing opacity", () =>
		{
			expect(declarationsFor(/\.breadcrumbs a:hover/u)).toStrictEqual(["text-decoration: underline;"]);
		});
	});

	describe("top bar styles guard", () =>
	{
		it("drops the leftover local-only top-bar rules", () =>
		{
			expect(
				hasSelector(
					styles,
					/\.top-bar-(button|star|menu|separator|avatar|dropdown|calendar-container|completed-container|layout-container|left|right|nav-buttons)\b/u,
				),
			).toBe(false);
		});

		it("drops the old top-bar search box rules", () =>
		{
			expect(hasSelector(styles, /\.top-bar-search-/u)).toBe(false);
		});

		it("styles the upstream .searchBox", () =>
		{
			expect(hasSelector(styles, /\.searchBoxInput\b/u)).toBe(true);
		});
	});

	const tailwind = readFileSync(fileURLToPath(new URL("../src/client/wf-tailwind.css", import.meta.url)), "utf8");

	function normalizedBlocks(css: string, selector: string): string[]
	{
		const stripped = css.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
		return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
			.filter((match) => match[1].trim() === selector)
			.map((match) =>
				match[2]
					.split(";")
					.map((declaration) => declaration.trim().replaceAll(/\s+/gu, " "))
					.filter((declaration) => declaration !== "")
					.join(";"),
			);
	}

	describe("flyout surface styles guard", () =>
	{
		it("leaves the flyout content-box so max-width 240 gives a 252px box", () =>
		{
			expect(normalizedBlocks(styles, ".wf-menu.flyout")).toStrictEqual(["line-height: 1"]);
		});

		it("scopes the light and dark .wf-menu tokens", () =>
		{
			expect(
				{
					light: normalizedBlocks(styles, "._theme-default .wf-menu"),
					dark: normalizedBlocks(styles, "._theme-dark .wf-menu"),
				},
			).toStrictEqual(
				{
					light: ["--wf-text-primary: var(--wf-gray-700);--wf-border-secondary: var(--wf-gray-400)"],
					dark: [
						"--wf-text-primary: var(--wf-dark-gray-200);--wf-border-primary: var(--wf-dark-gray-600);--wf-border-secondary: var(--wf-dark-gray-500)",
					],
				},
			);
		});

		it("relies on the cloned tailwind utilities for the surface and scroller", () =>
		{
			const selectors = [
				".flex",
				".flex-col",
				".border",
				".border-solid",
				".border-primary",
				".font-normal",
				".text-xs",
				".rounded-md",
				".bg-primary",
				".shadow-md",
				".overflow-x-hidden",
				String.raw`.\[transition\:200ms_opacity\]`,
				String.raw`.print\:hidden`,
				".overflow-y-auto",
				String.raw`.is-desktop .desktop\:max-h-\[min\(var\(--menu-max-h\)\2c calc\(100vh-50px\)\)\]`,
				String.raw`.\[\&\>\*\:first-child\]\:mt-xs>*:first-child`,
				String.raw`.\[\&\>\*\:last-child\]\:mb-xs>*:last-child`,
			];
			expect(
				Object.fromEntries(selectors.map((selector) => [selector, normalizedBlocks(tailwind, selector)])),
			).toStrictEqual(
				{
					".flex": ["display: flex"],
					".flex-col": ["flex-direction: column"],
					".border": ["border-width: 1px"],
					".border-solid": ["border-style: solid"],
					".border-primary": ["border-color: var(--wf-border-primary)"],
					".font-normal": ["font-weight: 400"],
					".text-xs": ["font-size: 0.79rem"],
					".rounded-md": ["border-radius: 0.375rem"],
					".bg-primary": ["background-color: var(--wf-background-primary)"],
					".shadow-md": [
						"--tw-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);--tw-shadow-colored: 0 4px 6px -1px var(--tw-shadow-color), 0 2px 4px -2px var(--tw-shadow-color);box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow)",
					],
					".overflow-x-hidden": ["overflow-x: hidden"],
					".\\[transition\\:200ms_opacity\\]": ["transition: 200ms opacity"],
					".print\\:hidden": ["display: none"],
					".overflow-y-auto": ["overflow-y: auto"],
					".is-desktop .desktop\\:max-h-\\[min\\(var\\(--menu-max-h\\)\\2c calc\\(100vh-50px\\)\\)\\]": [
						"max-height: min(var(--menu-max-h),calc(100vh - 50px))",
					],
					".\\[\\&\\>\\*\\:first-child\\]\\:mt-xs>*:first-child": ["margin-top: 0.25rem"],
					".\\[\\&\\>\\*\\:last-child\\]\\:mb-xs>*:last-child": ["margin-bottom: 0.25rem"],
				},
			);
		});
	});

	describe("menu item styles guard", () =>
	{
		it("keeps span.text subtexts out of the flex row rule", () =>
		{
			expect(hasSelector(styles, /\.wf-menu \.menuItem > span\s*\{/u)).toBe(false);
		});

		it("styles .wf-menu .menuItem rows, icons, shortcuts, separators and section headers", () =>
		{
			const selectors = [
				".wf-menu .menuItem",
				".wf-menu .menuItem.pl-xl",
				".wf-menu .menuItem.text-tertiary",
				".wf-menu .menuItem.canHover:hover",
				".wf-menu .menuItem.active",
				".wf-menu .menuItem > span:not(.text)",
				".wf-menu .menuItem > span > span:first-of-type",
				".menuItemIcon",
				".wf-menu .menuItem .text.ml-l",
				".wf-menu .border-t.my-s",
				".menu-section-header",
			];
			expect(
				Object.fromEntries(selectors.map((selector) => [selector, normalizedBlocks(styles, selector)])),
			).toStrictEqual(
				{
					".wf-menu .menuItem": [
						"display: block;padding: 4px 16px;line-height: 18.96px;white-space: nowrap;cursor: pointer;text-decoration: none !important;color: var(--wf-text-primary)",
					],
					".wf-menu .menuItem.pl-xl": ["padding-left: 24px"],
					".wf-menu .menuItem.text-tertiary": ["color: var(--wf-text-tertiary)"],
					".wf-menu .menuItem.canHover:hover": ["background: var(--wf-background-secondary)"],
					".wf-menu .menuItem.active": ["background: var(--wf-background-secondary)"],
					".wf-menu .menuItem > span:not(.text)": [
						"position: relative;display: flex;justify-content: space-between;align-items: center",
					],
					".wf-menu .menuItem > span > span:first-of-type": [
						"flex-grow: 1;display: flex;align-items: center;gap: 8px;overflow: hidden;text-overflow: ellipsis;white-space: nowrap;font-size: 0.79rem",
					],
					".menuItemIcon": ["display: flex;align-items: center;color: var(--wf-text-secondary)"],
					".wf-menu .menuItem .text.ml-l": [
						"margin-left: 16px;min-width: 22px;font-size: 0.79rem;color: var(--wf-text-tertiary)",
					],
					".wf-menu .border-t.my-s": ["border-top: 1px solid var(--wf-border-primary);margin: 6px 0"],
					".menu-section-header": [
						"padding: 8px 16px;font-size: 0.79rem;text-transform: uppercase;color: var(--wf-text-tertiary)",
					],
				},
			);
		});
	});

	describe("item menu trigger styles guard", () =>
	{
		const normalized = uncommented
			.replaceAll(/\s*([{}:;,>()])\s*/gu, "$1")
			.replaceAll(/\s+/gu, " ")
			.replaceAll(";}", "}");

		it("drops the local bullet-menu button rules", () =>
		{
			expect(hasSelector(styles, /\.node-context-menu-button\b|\.leaf \.nameButtons/u)).toBe(false);
		});

		it("keeps the page .scroller padding out of the menu scroller", () =>
		{
			expect(normalized.includes(".wf-menu .scroller{padding:0}")).toBe(true);
		});

		it("drops the local .node-context-menu body rules", () =>
		{
			expect(hasSelector(styles, /\.node-context-menu\b/u)).toBe(false);
		});

		it("has upstream's .itemMenu trigger rules", () =>
		{
			const rules = [
				".itemMenu{position:absolute !important;left:var(--item-menu-left);top:0;height:var(--line-height);padding-top:var(--wf-content-padding-top);display:flex;align-items:center;cursor:pointer;outline:none;transition:opacity 0.2s}",
				".itemMenu>div>span{display:block;width:24px;height:24px;border-radius:12px;color:var(--wf-text-tertiary)}",
				".itemMenu>div>span:hover,.itemMenu:focus>div>span{background:var(--wf-background-tertiary)}",
				".itemMenu:focus>div>span{color:var(--wf-text-quaternary)}",
				"body.moving .itemMenu{display:none}",
				".root>.name .itemMenu{left:65px;right:auto}",
			];
			expect(rules.filter((rule) => !normalized.includes(rule))).toStrictEqual([]);
		});
	});

	describe("page layout styles guard", () =>
	{
		const normalized = uncommented
			.replaceAll(/\s*([{}:;,>()])\s*/gu, "$1")
			.replaceAll(/\s+/gu, " ")
			.replaceAll(";}", "}");

		it("leaves .page content-box and clips overflow in .pageContainer like upstream", () =>
		{
			expect(
				{
					page: declarationsFor(/^\s*\.page\s*$/u),
					container: declarationsFor(/^\s*\.pageContainer\s*$/u),
					app: declarationsFor(/^\s*\.app\s*$/u),
				},
			).toStrictEqual(
				{
					page: [],
					container: ["overflow: auto;"],
					app: ["min-height: 100vh;\n\toverflow: hidden;"],
				},
			);
		});

		it("leaves no bare .outline-view page rule and no offline rule that moves the page", () =>
		{
			const offlineRules = [...uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].filter(
				(match) => /offline-banner/u.test(match[1]) && /(padding|margin)-top/u.test(match[2]),
			);
			expect(
				{
					bareOutlineView: declarationsFor(/^\s*\.outline-view\s*$/u),
					offlineTargets: offlineRules.map((match) => match[1].trim()),
				},
			).toStrictEqual(
				{
					bareOutlineView: [],
					offlineTargets: [],
				},
			);
		});

		it("keeps the page chrome unselectable but rows' text selectable", () =>
		{
			expect(
				pageClassName(
					{
						searching: false,
						showCompleted: false,
					},
				).split(" "),
			).toContain("select-none");
			expect(/\.content\b[^{}]*\{[^}]*user-select:\s*text/u.test(styles)).toBe(true);
		});

		it("keeps upstream's 30px unzoomed root title row", () =>
		{
			expect(normalized.includes(".mainTreeRoot>.name>.content{opacity:0;height:30px;")).toBe(true);
		});

		it("pads the search input's right side only when it carries pr-[72px]", () =>
		{
			expect(normalized.includes("padding:7px 2px 7px 30px;")).toBe(true);
			expect(normalized.includes(String.raw`.searchBoxInput.pr-\[72px\]{padding-right:72px}`)).toBe(true);
		});

		it("leaves the compact search magnifier at its 1em fa-1x size", () =>
		{
			expect(
				normalized.includes(
					String.raw`.searchBox .fa-magnifying-glass.left-\[10px\]{left:10px;width:1em;height:1em}`,
				),
			).toBe(true);
		});
	});

	describe("left bar styles guard", () =>
	{
		it("drops the legacy local sidebar rules", () =>
		{
			expect(
				hasSelector(styles, /\.left-sidebar|\.home-tree|slide-in-left|\.section-chevron|\.tree-toggle-icon/u),
			).toBe(false);
		});

		it("drops the placeholder section header and row rules, keeping the row label reset", () =>
		{
			expect(
				{
					header: declarationsFor(/^\s*\.left-bar-section-header\s*$/u),
					item: declarationsFor(/^\s*\.left-bar-section-item\s*$/u),
					label: declarationsFor(/^\s*\.left-bar-section-item \.innerContentContainer\s*$/u).length,
				},
			).toStrictEqual(
				{
					header: [],
					item: [],
					label: 1,
				},
			);
		});
	});

	describe("item type picker styles guard", () =>
	{
		it("drops the old local .layout-menu rules", () =>
		{
			expect(hasSelector(styles, /\.layout-menu\b/u)).toBe(false);
		});
	});

	describe("right bar styles guard", () =>
	{
		it("drops the local .right-sidebar and .shortcut-* rules", () =>
		{
			expect(
				hasSelector(styles, /\.right-sidebar|\.shortcut-(list|item|keys|description)|with-right-sidebar/u),
			).toBe(false);
		});

		it("relies on exactly one copy of the upstream right-bar utilities", () =>
		{
			const selectors = [
				".bg-quaternary",
				String.raw`.\!bg-tint`,
				String.raw`.min-w-\[96px\]`,
				String.raw`.tracking-\[0\.02em\]`,
			];
			expect(
				Object.fromEntries(
					selectors.map((selector) => [
						selector,
						{
							styles: normalizedBlocks(styles, selector).length,
							tailwind: normalizedBlocks(tailwind, selector).length,
						},
					]),
				),
			).toStrictEqual(
				{
					".bg-quaternary":
					{
						styles: 0,
						tailwind: 1,
					},
					".\\!bg-tint":
					{
						styles: 0,
						tailwind: 1,
					},
					".min-w-\\[96px\\]":
					{
						styles: 0,
						tailwind: 1,
					},
					".tracking-\\[0\\.02em\\]":
					{
						styles: 0,
						tailwind: 1,
					},
				},
			);
		});
	});

	describe("item selection styles guard", () =>
	{
		it("tints a selected row's whole block with upstream's square selection band", () =>
		{
			expect(cssBlock(styles, ".project.addedToSelection:before")).toStrictEqual(
				{
					content: '""',
					display: "block",
					position: "absolute",
					top: "0",
					right: "var(--item-selection-x-offset)",
					bottom: "0",
					left: "var(--item-selection-x-offset)",
					"border-radius": "0",
					background: "var(--wf-background-selected)",
				},
			);
		});

		it("dims the band to the tertiary background while the window is blurred", () =>
		{
			expect(cssBlock(styles, "body.wf-dom-window-blurred .project.addedToSelection:before")).toStrictEqual(
				{
					background: "var(--wf-background-tertiary)",
				},
			);
		});

		it("carries upstream's in-selection overrides", () =>
		{
			expect(
				Object.fromEntries(
					[
						".addedToSelection .bullet",
						".addedToSelection code",
						".project.addedToSelection .content .contentMatch",
						".code-block.addedToSelection .content",
						".quote-block.addedToSelection > .name .content .innerContentContainer",
						"body.item-selection--dragging *",
					].map((selector) => [selector, cssBlock(styles, selector)]),
				),
			).toStrictEqual(
				{
					".addedToSelection .bullet":
					{
						cursor: "grab",
					},
					".addedToSelection code":
					{
						background: "transparent",
						"border-color": "transparent",
					},
					".project.addedToSelection .content .contentMatch":
					{
						"background-color": "transparent",
					},
					".code-block.addedToSelection .content":
					{
						"background-color": "var(--wf-background-selected)",
						"border-color": "transparent",
					},
					".quote-block.addedToSelection > .name .content .innerContentContainer":
					{
						"border-color": "transparent",
					},
					"body.item-selection--dragging *":
					{
						cursor: "text !important",
					},
				},
			);
		});
	});

	describe("drop indicator styles guard", () =>
	{
		it("drops the old drag-over and dragging rules", () =>
		{
			expect(hasSelector(styles, /\.drag-over|\.name\.dragging|\.bullet:active|\.drop-line \.line/u)).toBe(false);
		});

		it("carries upstream's drop-line, line and drag-hovered rules", () =>
		{
			expect(
				Object.fromEntries(
					[
						".drop-line",
						".line",
						".project.drag-hovered-in > .drop-line",
						".project.drag-hovered-in:not(.selected) > .drop-line",
						".project.drag-hovered-at:after",
						"body.moving *",
						"body:not(.moving) .mainTreeRoot > .name, body:not(.moving) .mainTreeRoot > .notes",
						".is-desktop .bullet:hover > .bulletHalo, .is-desktop .dragging > .bullet > .bulletHalo",
					].map((selector) => [selector, cssBlock(styles, selector)]),
				),
			).toStrictEqual(
				{
					".drop-line":
					{
						display: "none",
						position: "relative",
						height: "0px",
						"z-index": "var(--wf-drop-line-z-index)",
					},
					".line":
					{
						position: "absolute",
						background: "#ccc",
						"border-radius": "2px",
						"pointer-events": "none",
						height: "4px",
						width: "100%",
					},
					".project.drag-hovered-in > .drop-line":
					{
						display: "block",
					},
					".project.drag-hovered-in:not(.selected) > .drop-line":
					{
						"margin-left": "35px",
					},
					".project.drag-hovered-at:after":
					{
						content: '""',
						position: "absolute",
						background: "#ccc",
						"border-radius": "2px",
						"pointer-events": "none",
						height: "4px",
						width: "100%",
						top: "calc(100% - 4px)",
						left: "0%",
					},
					"body.moving *":
					{
						cursor: "grab !important",
					},
					"body:not(.moving) .mainTreeRoot > .name, body:not(.moving) .mainTreeRoot > .notes":
					{
						"pointer-events": "none",
					},
					".is-desktop .bullet:hover > .bulletHalo, .is-desktop .dragging > .bullet > .bulletHalo":
					{
						"background-color": "color-mix(in srgb, var(--wf-background-quaternary) 85%, black)",
					},
				},
			);
		});
	});

	describe("move assistant styles guard", () =>
	{
		it("has no .move-assistant- selector", () =>
		{
			expect(hasSelector(styles, /\.move-assistant-/u)).toBe(false);
		});
	});

	describe("search panel styles guard", () =>
	{
		it("drops every .search-panel- rule", () =>
		{
			expect(hasSelector(styles, /\.search-panel-/u)).toBe(false);
		});
	});

	describe("show completed styles guard", () =>
	{
		it("drops the old show-completed popup and toggle switch rules", () =>
		{
			expect(hasSelector(styles, /\.hide-completed-popup\b|\.toggle-switch\b/u)).toBe(false);
		});
	});

	describe("node row anatomy styles guard", () =>
	{
		it("drops the old zoom-title ::before placeholder and styles upstream's placeholder element", () =>
		{
			expect(
				{
					oldRule: hasSelector(styles, /\.name--main > \.content:empty::before/u),
					wrapper: normalizedBlocks(styles, ".name .contentEditablePlaceholderWrapper"),
					placeholder: normalizedBlocks(styles, ".name .contentEditablePlaceholder"),
					prefix: normalizedBlocks(styles, ".prefix + .contentEditablePlaceholderWrapper"),
				},
			).toStrictEqual(
				{
					oldRule: false,
					wrapper: [
						"position: absolute;line-height: var(--font-selected-name-line-height);pointer-events: none",
					],
					placeholder: ["color: var(--wf-text-tertiary);line-height: var(--font-selected-name-line-height)"],
					prefix: ["padding-left: calc(var(--line-height))"],
				},
			);
		});

		it("leaves the item menu trigger content-box", () =>
		{
			expect(cssBlock(styles, ".itemMenu")["box-sizing"]).toBeUndefined();
		});

		it("lets the text span shrink to its text and resets the expand button font and bullet underline", () =>
		{
			expect(
				{
					flex: cssBlock(styles, ".innerContentContainer").flex,
					expandFont: cssBlock(styles, ".expand").font,
					expandLineHeight: cssBlock(styles, ".expand")["line-height"],
					bulletDecoration: cssBlock(styles, ".bullet")["text-decoration"],
					bulletFocus: hasSelector(styles, /\.bullet:focus/u),
				},
			).toStrictEqual(
				{
					flex: undefined,
					expandFont: "inherit",
					expandLineHeight: "inherit",
					bulletDecoration: "none",
					bulletFocus: false,
				},
			);
		});

		it("keeps a non-zero caret box on an empty editing span, which shrinks to zero width as a flex item", () =>
		{
			expect(cssBlock(styles, ".innerContentContainer.editing")).toStrictEqual(
				{
					"min-width": "1px",
				},
			);
		});

		it("ports the remaining wf-base row rules", () =>
		{
			expect(
				{
					hover: normalizedBlocks(
						styles,
						".name:not(.name--root):hover > .itemMenu,\n.name:not(.name--root):hover > .bullet",
					),
					print: /@media print\s*\{\s*\.name\s*\{\s*break-inside:\s*avoid;?\s*\}\s*\.nameButtons\s*\{\s*display:\s*none\s*!important;?\s*\}\s*\}/u.test(
						uncommented,
					),
					floating: hasSelector(styles, /\.project\.floating-conversations:before/u),
				},
			).toStrictEqual(
				{
					hover: ["opacity: 1 !important"],
					print: true,
					floating: true,
				},
			);
		});
	});

	describe("legacy code and quote styles guard", () =>
	{
		it("drops --color-bg-code and the old pre and blockquote wrappers", () =>
		{
			expect(
				{
					token: uncommented.includes("--color-bg-code"),
					pre: hasSelector(styles, /\.innerContentContainer pre\b/u),
					blockquote: hasSelector(styles, /\.innerContentContainer blockquote\b/u),
				},
			).toStrictEqual(
				{
					token: false,
					pre: false,
					blockquote: false,
				},
			);
		});
	});
});
