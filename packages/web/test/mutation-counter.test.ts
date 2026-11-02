import {MutationObserver, QueryClient} from "@tanstack/react-query";
import {describe, expect, it, vi} from "vite-plus/test";

vi.stubGlobal(
	"localStorage",
	{
		getItem: () => null,
		setItem: () =>
		{
		},
	},
);
vi.stubGlobal("matchMedia", () => (
{
	matches: false,
	addEventListener: () =>
	{
	},
}));
vi.stubGlobal(
	"document",
	{
		documentElement:
		{
			dataset: {},
		},
		body:
		{
			classList:
			{
				toggle: () => true,
				contains: () => false,
			},
		},
	},
);
vi.stubGlobal("addEventListener", () => {});

const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {installSaveTracking, trackReplay} = await import("../src/client/hooks/use-saving.js");
const {queryClientDefaults} = await import("../src/client/query-retry.js");

function deferred()
{
	let resolve: () => void = () =>
	{
	};
	let reject: (error: Error) => void = () =>
	{
	};
	const promise = new Promise<void>((res, rej) =>
	{
		resolve = res;
		reject = rej;
	});
	return {
		promise,
		resolve,
		reject,
	};
}

describe("the saving state counts every in-flight write", () =>
{
	it("counts overlapping mutations with TanStack's own count", async () =>
	{
		const client = new QueryClient(
			{
				defaultOptions: queryClientDefaults,
			},
		);
		const first = deferred();
		const second = deferred();
		const a = new MutationObserver(
			client,
			{
				mutationFn: async () => first.promise,
			},
		);
		const b = new MutationObserver(
			client,
			{
				mutationFn: async () => second.promise,
			},
		);
		const settledA = a.mutate().catch(() => {});
		const settledB = b.mutate().catch(() => {});
		const counts = [client.isMutating()];
		first.reject(new Error("boom"));
		await settledA;
		counts.push(client.isMutating());
		second.resolve();
		await settledB;
		counts.push(client.isMutating());
		expect(counts).toStrictEqual([2, 1, 0]);
	});

	it("counts undo/redo replays and stamps lastSavedAt when the last write settles", async () =>
	{
		const client = new QueryClient(
			{
				defaultOptions: queryClientDefaults,
			},
		);
		installSaveTracking(client);
		useOutlineStore.setState(
			{
				lastSavedAt: 0,
				replayCount: 0,
			},
		);
		vi.spyOn(Date, "now").mockReturnValue(5000);
		const replay = deferred();
		const tracked = trackReplay(replay.promise);
		const during =
		{
			replayCount: useOutlineStore.getState().replayCount,
			lastSavedAt: useOutlineStore.getState().lastSavedAt,
		};
		replay.resolve();
		await tracked;
		const after =
		{
			replayCount: useOutlineStore.getState().replayCount,
			lastSavedAt: useOutlineStore.getState().lastSavedAt,
		};
		vi.restoreAllMocks();
		expect(
			{
				during,
				after,
			},
		).toStrictEqual(
			{
				during:
				{
					replayCount: 1,
					lastSavedAt: 0,
				},
				after:
				{
					replayCount: 0,
					lastSavedAt: 5000,
				},
			},
		);
	});

	it("decrements a replay even when it fails", async () =>
	{
		useOutlineStore.setState(
			{
				replayCount: 0,
			},
		);
		await trackReplay(Promise.reject(new Error("x"))).catch(() => {});
		expect(useOutlineStore.getState().replayCount).toBe(0);
	});
});
