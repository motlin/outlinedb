/** The last write in line; the next one starts once it settles, whether it succeeded or failed. */
let tail: Promise<unknown> = Promise.resolve();

/**
 * Sends node writes one at a time in issue order, so an undo replay and a text save racing on a slow
 * network reach the server in the order the user made them rather than whichever answers first.
 */
export async function serializeWrite<T>(write: () => Promise<T>): Promise<T>
{
	const run = tail.then(write);
	tail = run.catch(() => {});
	return run;
}
