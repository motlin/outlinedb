/**
 * Maps a node's `metadata.layoutMode` value (as carried on `node.data.layoutMode`)
 * to the `.project` CSS class Workflowy applies for that block layout, plus flags
 * the renderer needs.
 *
 * Workflowy's convention: the `.project` class equals the `layoutMode` value, with
 * exceptions — headings map to `header{N}`, `todo` maps to `checkmark`, and the
 * default `bullets`/`bullet` and `numbered` (numbering renders as a prefix)
 * carry no class; `table` carries `tableItem` and `board` carries `board` (the renderer drops either for a layout that cannot render, see `canRenderLayout`). Quote and code
 * blocks also carry `multiline`, and a divider carries upstream's variant class list. The stored
 * values are `p` and `quote-block`; legacy `paragraph`, `quote` and `check` are
 * still read as aliases.
 *
 * Styling lives in styles.css keyed on `.project.<class>`. See
 * `.llm/web/node-type-coverage.md` for the upstream capture.
 */
import {dashboardsOn} from "../dashboard.js";

/** Upstream's divider `.project` classes, in upstream order. */
export const DIVIDER_CLASSES: readonly string[] = [
	"divider",
	"[&>.name]:items-center",
	"[&>.name>.content]:flex-none",
	"[&>.name>.content]:justify-center",
	"[&>.name>.content]:max-w-[calc(100%_-_48px)]",
	"[&>.name>.content]:min-w-0",
	"[&>.name>.content]:!px-s",
	"[&>.name>.content]:text-center",
	"[&>.name>.content]:text-tertiary",
	"[&>.name>.content]:text-s",
	"[&>.name>.content>.innerContentContainer]:max-w-full",
	"[&>.name>.content>.innerContentContainer]:w-auto",
	"[&>.name.empty:not(.name--focused)>.content]:!px-0",
	"[&>.name.empty:not(.name--focused)>.content]:!w-0",
	"project--bullet-on-hover",
];

export interface LayoutModeRendering {
	/** Classes appended to the node's `.project` element, in upstream order; empty for default bullets. */
	projectClasses: readonly string[];
	/** True when the layout puts a checkbox in the prefix slot (to-do). */
	isTodo: boolean;
}

const HEADING_CLASS: Record<string, string> = {
	h1: "header1",
	h2: "header2",
	h3: "header3",
};

function rendering(projectClasses: readonly string[], isTodo = false): LayoutModeRendering {
	return {projectClasses, isTodo};
}

/**
 * Resolve the rendering descriptor for a `layoutMode` value. Unknown or default
 * (`null`/`bullets`/`bullet`) values render as a plain bullet.
 */
export function resolveLayoutMode(
	layoutMode: string | null | undefined,
	flagOn: boolean = dashboardsOn(),
): LayoutModeRendering {
	if (!layoutMode || layoutMode === "bullets" || layoutMode === "bullet") {
		return rendering([]);
	}

	const heading = HEADING_CLASS[layoutMode];
	if (heading) {
		return rendering([heading]);
	}

	if (layoutMode === "todo" || layoutMode === "check") {
		return rendering(["checkmark"], true);
	}

	if (layoutMode === "code-block") {
		return rendering(["code-block", "multiline"]);
	}

	if (layoutMode === "quote" || layoutMode === "quote-block") {
		return rendering(["quote-block", "multiline"]);
	}

	if (layoutMode === "divider") {
		return rendering(DIVIDER_CLASSES);
	}

	if (layoutMode === "dashboard") {
		return rendering(flagOn ? ["dashboard"] : []);
	}

	if (layoutMode === "board") {
		return rendering(["board"]);
	}

	if (layoutMode === "table") {
		return rendering(["tableItem"]);
	}

	if (layoutMode === "paragraph" || layoutMode === "p") {
		return rendering(["paragraph"]);
	}

	return rendering([]);
}
