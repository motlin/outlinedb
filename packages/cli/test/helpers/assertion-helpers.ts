import {expect} from "vite-plus/test";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";

interface TemporalRecord {
	systemTo: string;
}

export function expectActiveRecord(node: TemporalRecord): void {
	expect(node.systemTo, "Node should be active (systemTo = FAR_FUTURE_DATE)").toBe(FAR_FUTURE_DATE);
}

export function expectPhasedOut(node: TemporalRecord, expectedSystemTo?: string): void {
	expect(node.systemTo, "Node should be phased out (systemTo != FAR_FUTURE_DATE)").not.toBe(FAR_FUTURE_DATE);

	if (expectedSystemTo !== undefined) {
		expect(node.systemTo, "Node.systemTo should match expected").toBe(expectedSystemTo);
	}
}

/** A copy of a temporal row without its dynamic `systemFrom`, for deep equality. */
export function withoutSystemFrom<T extends {systemFrom: string}>(
	row: T | undefined,
): Omit<T, "systemFrom"> | undefined {
	if (row === undefined) {
		return undefined;
	}
	const {systemFrom: _systemFrom, ...rest} = row;
	return rest;
}
