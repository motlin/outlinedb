import {useAccountSync} from "../hooks/use-account-sync.js";
import type {AccountSync} from "../../node-types.js";
import {LoadingSpinner} from "./loading-spinner.js";

const PANEL_CLASS = "empty-outline flex flex-col gap-y-xs py-m text-s leading-base text-primary print:hidden";

/**
 * The unzoomed outline with no items: the first import's progress while it runs, else one line pointing at the add
 * button. A new standalone account's onboarding is its seeded welcome outline, so this is only the fallback for an
 * outline the user emptied. Renders nothing until the sync state is known, so an account still importing never
 * flashes it.
 */
function EmptyOutline({sync}: {sync: AccountSync | undefined})
{
	if (sync === undefined)
	{
		return null;
	}
	if (sync.phase !== "idle")
	{
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
			<p>Your outline is empty. Click the + below to add your first bullet.</p>
		</section>
	);
}

/** {@link EmptyOutline} reading the account's sync state; mounted only while the unzoomed outline is empty. */
export function RootEmptyOutline()
{
	return <EmptyOutline sync={useAccountSync()} />;
}
