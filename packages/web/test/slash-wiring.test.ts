import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";

function source(path: string): string
{
	return readFileSync(new URL(`../src/client/components/${path}`, import.meta.url), "utf8");
}

/** The body of the `const <name> = useCallback(` declaration, up to its dependency list. */
function callbackBody(text: string, name: string): string
{
	const start = text.indexOf(`const ${name} = useCallback(`);
	if (start === -1)
	{
		return "";
	}
	const end = text.indexOf("\n\t}, [", start);
	return text.slice(start, end === -1 ? undefined : end);
}

describe("slash menu wiring", () =>
{
	it("wires useSlashMenu into both editors' input and keydown, and strips the chip in their save paths", () =>
	{
		const files = [
			["editable-text.tsx", "saveInPlace"],
			["editable-note.tsx", "saveNow"],
		] as const;
		expect(
			files.map(([file, save]) =>
			{
				const text = source(file);
				return [
					file,
					text.includes('import {useSlashMenu} from "../hooks/use-slash-menu.js";'),
					text.includes("onInput={handleInput}"),
					/handleSlashInput\(/u.test(callbackBody(text, "handleInput")),
					/^\t{3}if \(handleSlashKey\(event\)\)\n\t{3}\{$/mu.test(callbackBody(text, "handleKeyDown")),
					callbackBody(text, save).includes("stripSlashChip("),
				];
			}),
		).toStrictEqual([
			["editable-text.tsx", true, true, true, true, true],
			["editable-note.tsx", true, true, true, true, true],
		]);
	});

	it("passes evalMath to resolveSlash so /2*3 offers the = math group", () =>
	{
		const text = readFileSync(new URL("../src/client/hooks/use-slash-menu.tsx", import.meta.url), "utf8");
		expect([
			text.includes('import {evalMath} from "../slash-math.js";'),
			/resolveSlash\(\n\t\tchipText,\n\t\t\{[\s\S]*?\n\t{3}evalMath,\n\t\t\},\n\t\);/u.test(text),
		]).toStrictEqual([true, true]);
	});
});
