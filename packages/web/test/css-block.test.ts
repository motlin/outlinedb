import {describe, expect, it} from "vite-plus/test";
import {cssPreludes, hasSelector} from "./helpers/css-block.js";

describe("cssPreludes", () =>
{
	it("returns the text before each opening brace, including at-rules and rules nested in them", () =>
	{
		expect(
			cssPreludes(".a { color: red; }\n@media (min-width: 1px) {\n\t.b, .c { margin: 0 }\n}\n.d{}{}.e {x: y}"),
		).toStrictEqual([".a ", "\n@media (min-width: 1px) ", "\n\t.b, .c ", "\n.d", ".e "]);
	});
});

describe("hasSelector", () =>
{
	it("matches rule preludes with comments stripped", () =>
	{
		const css = "/* .ghost { } */\n.real { color: red; }";
		expect(
			{
				real: hasSelector(css, /^\s*\.real\s*$/u),
				ghost: hasSelector(css, /\.ghost/u),
				declaration: hasSelector(css, /color/u),
			},
		).toStrictEqual(
			{
				real: true,
				ghost: false,
				declaration: false,
			},
		);
	});
});
