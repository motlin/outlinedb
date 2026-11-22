import {memo} from "react";
import {useAccountSync} from "../hooks/use-account-sync.js";

/**
 * The main page's banner while the account's sync stopped until an admin seed (`needs_seed`): its error and that nothing
 * retries it, above the rows whatever the outline holds, since nothing else says the outline stopped updating.
 */
export const SyncStoppedNotice = memo(function SyncStoppedNotice()
{
	const sync = useAccountSync();
	if (sync?.phase !== "needs_seed")
	{
		return null;
	}
	return (
		<section
			className="sync-stopped-notice mb-m px-m py-s rounded text-s leading-base text-primary bg-warning print:hidden"
			aria-live="polite"
		>
			<p>
				<strong>Sync stopped.</strong> {sync.error}
			</p>
			<p>Nothing retries it on a schedule; an admin seed restarts the sync.</p>
		</section>
	);
});
