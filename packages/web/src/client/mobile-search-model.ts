/** Upstream's mobile search form shows while the input is focused or a search is typed or committed. */
export function mobileSearchVisible({focused, input, query}: {focused: boolean; input: string; query: string}): boolean
{
	return focused || input !== "" || query !== "";
}

/** Blur runs the search, or cancels it when the input is empty. */
export function mobileSearchBlurAction(value: string): "commit" | "cancel"
{
	return value === "" ? "cancel" : "commit";
}
