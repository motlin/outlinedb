import {flushEditing} from "./stores/outline.js";
import type {Command} from "./keys/dispatch.js";

/** Upstream `save_and_sync` (⌘S / ⌃S): save the edited text in place, keeping the caret, then sync. */
export function saveAndSyncCommand(sync: () => void): Command
{
	return {
		execute()
		{
			flushEditing();
			sync();
		},
	};
}
