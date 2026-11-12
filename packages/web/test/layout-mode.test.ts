import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {DIVIDER_CLASSES, resolveLayoutMode} from "../src/client/components/layout-mode.js";

describe("resolveLayoutMode", () =>
{
	it.each([
		[
			"bullets",
			{
				projectClasses: [],
				isTodo: false,
			},
		],
		[
			"h1",
			{
				projectClasses: ["header1"],
				isTodo: false,
			},
		],
		[
			"h2",
			{
				projectClasses: ["header2"],
				isTodo: false,
			},
		],
		[
			"h3",
			{
				projectClasses: ["header3"],
				isTodo: false,
			},
		],
		[
			"p",
			{
				projectClasses: ["paragraph"],
				isTodo: false,
			},
		],
		[
			"paragraph",
			{
				projectClasses: ["paragraph"],
				isTodo: false,
			},
		],
		[
			"todo",
			{
				projectClasses: ["checkmark"],
				isTodo: true,
			},
		],
		[
			"check",
			{
				projectClasses: ["checkmark"],
				isTodo: true,
			},
		],
		[
			"numbered",
			{
				projectClasses: [],
				isTodo: false,
			},
		],
		[
			"board",
			{
				projectClasses: ["board"],
				isTodo: false,
			},
		],
		[
			"table",
			{
				projectClasses: ["tableItem"],
				isTodo: false,
			},
		],
		[
			"quote-block",
			{
				projectClasses: ["quote-block", "multiline"],
				isTodo: false,
			},
		],
		[
			"quote",
			{
				projectClasses: ["quote-block", "multiline"],
				isTodo: false,
			},
		],
		[
			"code-block",
			{
				projectClasses: ["code-block", "multiline"],
				isTodo: false,
			},
		],
		[
			"divider",
			{
				projectClasses: DIVIDER_CLASSES,
				isTodo: false,
			},
		],
	])("resolves %s", (layoutMode, expected) =>
	{
		expect(resolveLayoutMode(layoutMode)).toStrictEqual(expected);
	});

	it("lists upstream's divider classes in order", () =>
	{
		expect(DIVIDER_CLASSES.join(" ")).toBe(
			"divider [&>.name]:items-center [&>.name>.content]:flex-none [&>.name>.content]:justify-center [&>.name>.content]:max-w-[calc(100%_-_48px)] [&>.name>.content]:min-w-0 [&>.name>.content]:!px-s [&>.name>.content]:text-center [&>.name>.content]:text-tertiary [&>.name>.content]:text-s [&>.name>.content>.innerContentContainer]:max-w-full [&>.name>.content>.innerContentContainer]:w-auto [&>.name.empty:not(.name--focused)>.content]:!px-0 [&>.name.empty:not(.name--focused)>.content]:!w-0 project--bullet-on-hover",
		);
	});
});

const CLIENT_DIR = fileURLToPath(new URL("../src/client", import.meta.url));

function clientSources(dir: string): string[]
{
	return readdirSync(
		dir,
		{
			withFileTypes: true,
		},
	).flatMap((entry) =>
	{
		const full = join(dir, entry.name);
		if (entry.isDirectory())
		{
			return clientSources(full);
		}
		return /\.tsx?$/u.test(entry.name) ? [full] : [];
	});
}

describe("stored layoutMode writes", () =>
{
	it("never writes the legacy paragraph/quote values upstream ignores", () =>
	{
		const legacyWrite =
			/layoutMode: "(paragraph|quote)"|setLayoutMode\([^)]*"(paragraph|quote)"\)|id: "(paragraph|quote)"/u;
		const offenders = clientSources(CLIENT_DIR).filter((file) => legacyWrite.test(readFileSync(file, "utf8")));
		expect(offenders).toStrictEqual([]);
	});
});
