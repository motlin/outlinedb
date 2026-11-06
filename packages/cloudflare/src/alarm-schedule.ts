/** The jobs sharing the Durable Object's one alarm. */
type AlarmJob = "sync" | "embeddings";

const JOBS: readonly AlarmJob[] = ["sync", "embeddings"];

/** One job's view of the alarm, shaped like the storage calls a job used before the alarm was shared. */
export interface JobAlarm {
	setAlarm(at: number): Promise<void>;
	getAlarm(): number | null | Promise<number | null>;
}

/**
 * Several jobs sharing the Durable Object's one alarm. Each job's due time is kept in the object's key-value storage
 * and the alarm is armed at the earliest, so an embedding batch never makes the sync start a run before it is due.
 */
export class AlarmSchedule {
	constructor(private readonly storage: DurableObjectStorage) {}

	private key(job: AlarmJob): string {
		return `alarm:${job}`;
	}

	/** Adopt an alarm armed before the schedule existed as the sync's due time. */
	async adoptLegacyAlarm(): Promise<void> {
		if (this.due("sync") === null && this.due("embeddings") === null) {
			const armed = await this.storage.getAlarm();
			if (armed !== null) {
				this.storage.kv.put(this.key("sync"), armed);
			}
		}
	}

	due(job: AlarmJob): number | null {
		const at: unknown = this.storage.kv.get(this.key(job));
		return typeof at === "number" ? at : null;
	}

	/** Whether the job is due at `now`; a due job's time is cleared, since running it consumes it. */
	take(job: AlarmJob, now: number): boolean {
		const at = this.due(job);
		if (at === null || at > now) {
			return false;
		}
		this.storage.kv.delete(this.key(job));
		return true;
	}

	async set(job: AlarmJob, at: number): Promise<void> {
		this.storage.kv.put(this.key(job), at);
		await this.arm();
	}

	/** Arm the alarm at the earliest due time, or clear it when no job is due. */
	async arm(): Promise<void> {
		const times = JOBS.flatMap((job) => {
			const at = this.due(job);
			return at === null ? [] : [at];
		});
		await (times.length === 0 ? this.storage.deleteAlarm() : this.storage.setAlarm(Math.min(...times)));
	}

	for(job: AlarmJob): JobAlarm {
		return {
			setAlarm: async (at) => this.set(job, at),
			getAlarm: () => this.due(job),
		};
	}
}
