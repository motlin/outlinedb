import {systemClock} from "../../src/cache/system-time.js";

/**
 * Every Date.now() read in a test returns a later millisecond than the read
 * before it, and the microsecond system clock reads Date.now() * 1000, so it
 * steps with it. A unit of work that closes a version stamped at its own
 * microsecond fails (SameMicrosecondOverwriteError). In production, units of
 * work that touch one row are separated by a network round trip; a fake API
 * answers in microseconds, so back-to-back units would share a timestamp.
 * One unit still reads the clock once, so a unit that overwrites its own
 * version still fails here. vi.useFakeTimers replaces Date, and the system
 * clock follows whatever Date is installed, so tests that freeze time keep
 * their exact stamps.
 */
const realNow = Date.now.bind(Date);
let last = 0;
Date.now = (): number =>
{
	last = Math.max(realNow(), last + 1);
	return last;
};
systemClock.readMicros = (): number => Date.now() * 1000;
