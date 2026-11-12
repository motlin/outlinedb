// Upstream WF.DomKit.Input; its whitespace-only lines and 12-space indents are rebuilt here so no trailing space sits in the source.
const INDENT = " ".repeat(12);

/** The DomKit Input class string; `small` adds upstream's `py-xs px-s` after the base padding. */
export function domkitInputClass(size: "default" | "small" = "default"): string
{
	return [
		`block w-full box-border appearance-none p-m rounded-s${size === "small" ? " py-xs px-s" : ""}`,
		INDENT,
		INDENT,
		`${INDENT}outline-none border border-solid border-primary bg-primary focus:border-tint`,
		INDENT,
		INDENT,
		`${INDENT}text-s leading-s text-primary placeholder:text-tertiary selection:bg-selected`,
		`${INDENT}[&:-webkit-autofill]:shadow-[0_0_0_1000px_#e4f5ff_inset]`,
		`${INDENT}[&:-webkit-autofill]:[-webkit-text-fill-color:inherit]`,
		`${INDENT}[&:-webkit-autofill]:border-tint`,
		`${INDENT}[&:-webkit-autofill:hover]:shadow-[0_0_0_1000px_#e4f5ff_inset]`,
		`${INDENT}[&:-webkit-autofill:focus]:shadow-[0_0_0_1000px_#e4f5ff_inset]`,
		`${INDENT}[&:autofill]:shadow-[0_0_0_1000px_#e4f5ff_inset]`,
		`${INDENT}[&:autofill:hover]:shadow-[0_0_0_1000px_#e4f5ff_inset]`,
		`${INDENT}[&:autofill:focus]:shadow-[0_0_0_1000px_#e4f5ff_inset]`,
		INDENT,
	].join("\n");
}
