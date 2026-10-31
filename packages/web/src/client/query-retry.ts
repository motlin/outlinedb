import {RequestStatusError} from "./request-error.js";
import {shareById} from "./structural-sharing.js";

/**
 * Retries transient query failures. Client errors (4xx except 408 timeout and 429 rate limit) never succeed on
 * retry, so they fail fast.
 */
export function shouldRetry(failureCount: number, error: Error): boolean {
	if (failureCount >= 3) {
		return false;
	}
	if (
		error instanceof RequestStatusError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 408 &&
		error.status !== 429
	) {
		return false;
	}
	return true;
}

/** Exponential backoff: 1s, 2s, 4s. */
function getRetryDelay(attemptIndex: number): number {
	return Math.min(1000 * 2 ** attemptIndex, 4000);
}

/**
 * Mutations never retry: create and move POSTs are not idempotent, so a retry can duplicate the write. Cached lists
 * share their unchanged rows by id (`shareById`), so a row a write did not touch keeps its object.
 */
export const queryClientDefaults = {
	queries: {
		structuralSharing: shareById,
		staleTime: 1000 * 60,
		refetchOnWindowFocus: false,
		retry: shouldRetry,
		retryDelay: getRetryDelay,
	},
	mutations: {retry: false},
};
