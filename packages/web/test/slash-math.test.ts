import {describe, expect, it} from "vite-plus/test";
import {evalMath} from "../src/client/slash-math.js";

describe("evalMath", () =>
{
	it("returns the result as a string", () =>
	{
		expect(evalMath("2*3")).toBe("6");
		expect(evalMath("10/4")).toBe("2.5");
	});

	it("returns incomplete while the expression is still being typed", () =>
	{
		expect(evalMath("2*")).toBe("incomplete");
	});

	it("returns null for anything that is not math", () =>
	{
		expect(evalMath("abc")).toBeNull();
	});
});
