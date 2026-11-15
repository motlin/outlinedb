import {describe, expect, it} from "vite-plus/test";
import {AlarmSchedule} from "../src/alarm-schedule";

/** The slice of Durable Object storage the schedule uses: key-value storage and the one alarm. */
function fakeStorage()
{
	const kv = new Map<string, unknown>();
	const state =
	{
		alarm: null as number | null,
	};
	const storage =
	{
		kv:
		{
			get: (key: string) => kv.get(key),
			put: (key: string, value: unknown) =>
			{
				kv.set(key, value);
			},
			delete: (key: string) => kv.delete(key),
		},
		getAlarm: async () => Promise.resolve(state.alarm),
		setAlarm: async (at: number) =>
		{
			state.alarm = at;
			return Promise.resolve();
		},
		deleteAlarm: async () =>
		{
			state.alarm = null;
			return Promise.resolve();
		},
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schedule calls only these members
	return {
		schedule: new AlarmSchedule(storage as unknown as DurableObjectStorage),
		state,
	};
}

describe("AlarmSchedule", () =>
{
	it("takes the due jobs in run order, the outbox drain before the sync, and arms the alarm at the earliest remaining job", async () =>
	{
		const {schedule, state} = fakeStorage();
		await schedule.set("sync", 100);
		await schedule.set("embeddings", 300);
		const armedBeforeWrite = state.alarm;
		// A mirror-mode write arms the outbox job for now.
		await schedule.set("outbox", 50);
		const armedAfterWrite = state.alarm;

		const due = schedule.takeDue(250);
		await schedule.arm();

		expect(
			{
				armedBeforeWrite,
				armedAfterWrite,
				due,
				remaining:
				{
					outbox: schedule.due("outbox"),
					sync: schedule.due("sync"),
					embeddings: schedule.due("embeddings"),
				},
				armed: state.alarm,
			},
		).toStrictEqual(
			{
				armedBeforeWrite: 100,
				armedAfterWrite: 50,
				due: ["outbox", "sync"],
				remaining:
				{
					outbox: null,
					sync: null,
					embeddings: 300,
				},
				armed: 300,
			},
		);
	});
});
