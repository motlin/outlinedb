import {describe, expect, it} from "vite-plus/test";
import {accountRows, snapshotFromRows} from "../src/cache/account-store.js";
import type {AccountSnapshot} from "../src/cache/account-store.js";

function snapshotWithSurveys(surveys: Record<string, unknown>): AccountSnapshot {
	return {
		account: {userId: 7, dateJoinedSec: 1_324_752_241},
		rootMetadata: {surveys},
		settings: {},
		visibleFeatures: [],
	};
}

describe("account store surveys", () => {
	it("stores each survey's status, rating and time, and rebuilds the same root metadata from the rows", () => {
		const surveys = {
			"workflowy-experience-v1": {status: "submitted", rating: 4, at: 1_793_201_591_840},
			"panes-v1": {status: "dismissed", at: 1_793_201_500_000},
		};
		const rows = accountRows(snapshotWithSurveys(surveys));

		expect({
			rows: rows.surveys,
			rebuilt: snapshotFromRows(rows)?.rootMetadata.surveys,
		}).toStrictEqual({
			rows: [
				{survey: "workflowy-experience-v1", status: "submitted", rating: 4, at: 1_793_201_591_840},
				{survey: "panes-v1", status: "dismissed", rating: null, at: 1_793_201_500_000},
			],
			rebuilt: surveys,
		});
	});
});
