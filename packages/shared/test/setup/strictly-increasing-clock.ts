/**
 * Every Date.now() read in a test returns a later millisecond than the read
 * before it. A unit of work that closes a version stamped at its own
 * millisecond fails (SameMillisecondOverwriteError). In production, units of
 * work that touch one row are separated by a network round trip; a fake API
 * answers in microseconds, so back-to-back units would share a millisecond.
 * One unit still reads the clock once, so a unit that overwrites its own
 * version still fails here. vi.useFakeTimers replaces Date, so tests that
 * freeze time keep their exact stamps.
 */
const realNow = Date.now.bind(Date);
let last = 0;
Date.now = (): number =>
{
	last = Math.max(realNow(), last + 1);
	return last;
};
