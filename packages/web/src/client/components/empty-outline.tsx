import {useAccountSync} from "../hooks/use-account-sync.js";
import type {AccountSync} from "../../node-types.js";
import {LoadingSpinner} from "./loading-spinner.js";

/** The first steps a new user needs; the server seeds the same tips under a standalone account's welcome item. */
const EMPTY_OUTLINE_TIPS = [
	"Press Enter to add a bullet, Tab to indent it and Shift+Tab to outdent it",
	"Click a bullet to zoom into it; the breadcrumbs at the top take you back out",
	"Press Ctrl+K (Cmd+K on a Mac) to jump to any item by name, or type in the search box to filter",
	"Type #tags or @mentions anywhere in a bullet, then click one to see everything that has it",
	"Press Ctrl+Enter (Cmd+Enter on a Mac) to complete an item",
] as const;

const PANEL_CLASS = "empty-outline flex flex-col gap-y-xs py-m text-s leading-base text-primary print:hidden";

/**
 * The unzoomed outline with no items: the first import's progress while it runs, else a welcome with tips. Renders
 * nothing until the sync state is known, so an account still importing never flashes the welcome.
 */
function EmptyOutline({sync}: {sync: AccountSync | undefined}) {
	if (sync === undefined) {
		return null;
	}
	if (sync.phase !== "idle") {
		return (
			<section className={`${PANEL_CLASS} empty-outline--syncing`} aria-live="polite">
				<LoadingSpinner size="small" />
				<h2 className="font-semibold">Importing your outline</h2>
				<p>
					{sync.applied === 0
						? "Fetching your items."
						: `${sync.applied.toLocaleString("en-US")} items imported so far.`}{" "}
					They appear here as soon as the import finishes.
				</p>
			</section>
		);
	}
	return (
		<section className={`${PANEL_CLASS} empty-outline--welcome`}>
			<h2 className="font-semibold">Welcome to OutlineDB</h2>
			<p>Your outline is empty. Click the + below to add your first bullet.</p>
			<ul className="list-disc pl-l">
				{EMPTY_OUTLINE_TIPS.map((tip) => (
					<li key={tip}>{tip}</li>
				))}
			</ul>
		</section>
	);
}

/** {@link EmptyOutline} reading the account's sync state; mounted only while the unzoomed outline is empty. */
export function RootEmptyOutline() {
	return <EmptyOutline sync={useAccountSync()} />;
}
