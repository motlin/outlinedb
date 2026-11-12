import mexpModule from "math-expression-evaluator";

type MexpClass = typeof mexpModule.default;

/** The typings declare an ES default export, but the CommonJS runtime sets module.exports to the class itself. */
function isMexpClass(value: unknown): value is MexpClass
{
	return typeof value === "function";
}

const Mexp = isMexpClass(mexpModule) ? mexpModule : mexpModule.default;

/**
 * Port of upstream's `slash.math` resolver evaluation: the result as a string, "incomplete" when
 * math-expression-evaluator reports "complete the expression", and null for any other error.
 */
export function evalMath(expression: string): string | null
{
	try
	{
		return String(new Mexp().eval(expression));
	}
	catch (error)
	{
		return error instanceof Error && error.message === "complete the expression" ? "incomplete" : null;
	}
}
