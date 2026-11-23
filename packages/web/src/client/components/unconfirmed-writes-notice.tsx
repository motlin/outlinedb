import {memo} from "react";
import {useAccountSync} from "../hooks/use-account-sync.js";

/**
 * The main page's banner while workflowy.com's reply to a push left some of its writes out: how many, that they are not
 * sent again, and that a sync showing them settles them.
 */
export const UnconfirmedWritesNotice = memo(function UnconfirmedWritesNotice()
{
	const count = useAccountSync()?.unconfirmedWrites ?? 0;
	if (count === 0)
	{
		return null;
	}
	return (
		<section
			className="unconfirmed-writes-notice mb-m px-m py-s rounded text-s leading-base text-primary bg-warning print:hidden"
			aria-live="polite"
		>
			<p>
				<strong>
					{count.toLocaleString()} {count === 1 ? "change" : "changes"} not confirmed by workflowy.com.
				</strong>{" "}
				Its reply to the push left {count === 1 ? "it" : "them"} out.
			</p>
			<p>Not sent again; the next sync that shows {count === 1 ? "it" : "them"} on workflowy.com clears this.</p>
		</section>
	);
});
