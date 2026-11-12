import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";

const CLIENT_ROOT = path.resolve(import.meta.dirname, "../src/client");

function tsxFiles(dir: string): string[]
{
	return fs
		.readdirSync(
			dir,
			{
				withFileTypes: true,
			},
		)
		.flatMap((entry) =>
		{
			const full = path.join(dir, entry.name);
			if (entry.isDirectory())
			{
				return tsxFiles(full);
			}
			return entry.name.endsWith(".tsx") ? [full] : [];
		});
}

/** The JSX opening tag starting at `start`, skipping `>` inside `{...}` expressions. */
function openingTag(source: string, start: number): string
{
	let depth = 0;
	for (let index = start; index < source.length; index++)
	{
		const char = source[index];
		if (char === "{")
		{
			depth++;
		}
		else if (char === "}")
		{
			depth--;
		}
		else if (char === ">" && depth === 0)
		{
			return source.slice(start, index + 1);
		}
	}
	return source.slice(start);
}

/** Every `<input>`, `<textarea>`, and `<select>` in the client lacking an `id` or `name` attribute, as `file:line`. */
// The location picker and left-bar rename inputs are exact upstream clone (class, type, placeholder, value only), so it carries no name.
const UPSTREAM_CLONE_FILES = new Set(["components/location-picker.tsx", "components/left-sidebar.tsx"]);

function unnamedFormFields(): string[]
{
	const unnamed: string[] = [];
	for (const file of tsxFiles(CLIENT_ROOT))
	{
		if (UPSTREAM_CLONE_FILES.has(path.relative(CLIENT_ROOT, file)))
		{
			continue;
		}
		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(/<(?:input|textarea|select)\b/gu))
		{
			const tag = openingTag(source, match.index);
			if (!/\s(?:id|name)=/u.test(tag))
			{
				const line = source.slice(0, match.index).split("\n").length;
				unnamed.push(`${path.relative(CLIENT_ROOT, file)}:${line}`);
			}
		}
	}
	return unnamed;
}

describe("form fields", () =>
{
	it("every input, textarea, and select has an id or name so DevTools' Issues panel stays empty", () =>
	{
		expect(unnamedFormFields()).toStrictEqual([]);
	});
});
