import {describe, expect, it} from "vite-plus/test";
import {linkColorCss} from "../src/client/link-color-style.js";

describe("linkColorCss", () => {
	it("Blue: the tint rule, the workflowy.com and localhost overrides, then the search-match sky rule", () => {
		expect(linkColorCss(false)).toBe(
			[
				".contentLink { color: var(--wf-text-tint); }",
				".contentLink[href^='https://workflowy.com'],.contentLink[href^='https://dev.workflowy.com'],.contentLink[href^='https://beta.workflowy.com'],.contentLink[href^='http://workflowy.com'],.contentLink[href^='http://dev.workflowy.com'],.contentLink[href^='http://beta.workflowy.com'],.contentLink[href^='http://localhost'] { color: var(--wf-text-tertiary); }",
				".fullMatch .contentLink, .project.metaMatches .contentLink { color: var(--wf-text-sky); }",
			].join("\n"),
		);
	});

	it("Gray: only the tertiary rule", () => {
		expect(linkColorCss(true)).toBe(".contentLink { color: var(--wf-text-tertiary); }");
	});
});
