import {describe, expect, it} from "vite-plus/test";
import {serializeWrite} from "../src/client/write-order.js";

describe("serializeWrite", () =>
{
	it("starts each write only after the one issued before it settles", async () =>
	{
		const events: string[] = [];
		let release = (): void =>
		{
		};
		const first = serializeWrite(async () =>
		{
			events.push("start 1");
			await new Promise<void>((resolve) =>
			{
				release = resolve;
			});
			events.push("end 1");
			return 1;
		});
		const second = serializeWrite(async () =>
		{
			events.push("start 2");
			return Promise.resolve(2);
		});
		await new Promise<void>((resolve) =>
		{
			setTimeout(resolve, 0);
		});
		expect(events).toStrictEqual(["start 1"]);
		release();
		await expect(Promise.all([first, second])).resolves.toStrictEqual([1, 2]);
		expect(events).toStrictEqual(["start 1", "end 1", "start 2"]);
	});

	it("runs the next write after a failed one", async () =>
	{
		const failed = serializeWrite(async () => Promise.reject(new Error("offline")));
		const next = serializeWrite(async () => Promise.resolve("ok"));
		await expect(failed).rejects.toThrow("offline");
		await expect(next).resolves.toBe("ok");
	});
});
