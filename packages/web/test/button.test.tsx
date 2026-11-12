// @vitest-environment happy-dom
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vite-plus/test";
import {Button} from "../src/client/components/button.js";

describe("Button", () =>
{
	it("uses an explicit className verbatim, then button and the variant, with no type attribute", () =>
	{
		const html = renderToStaticMarkup(
			<Button variant="secondary" className="!px-xs !py-xs !text-xs !rounded-pill">
				x
			</Button>,
		);
		expect(html).toBe(
			'<button tabindex="0" class="!px-xs !py-xs !text-xs !rounded-pill button secondary"><span class="">x</span></button>',
		);
	});
});
