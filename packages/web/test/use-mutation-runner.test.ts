// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement, Profiler, useEffect} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {useMutationRunner} = await import("../src/client/hooks/use-mutation-runner.js");

let root: Root | undefined;

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
	act(() => {
		root?.unmount();
	});
	root = undefined;
	document.body.innerHTML = "";
});

async function pause(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 10);
	});
}

type Runner = ReturnType<typeof useMutationRunner<string, string, unknown>>;

/** Mounts a component holding a runner over `mutationFn`; returns the runner and its render count. */
function mountRunner(mutationFn: (variables: string) => Promise<string>, events: string[]) {
	const client = new QueryClient();
	const state: {runner: Runner | null; renders: number} = {runner: null, renders: 0};
	function Holder() {
		const runner = useMutationRunner<string, string, unknown>({
			mutationFn,
			onSuccess: (data) => {
				events.push(`options success ${data}`);
			},
		});
		useEffect(() => {
			state.runner = runner;
		});
		return null;
	}
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => {
		root?.render(
			createElement(
				QueryClientProvider,
				{client},
				createElement(
					Profiler,
					{
						id: "holder",
						onRender: () => {
							state.renders++;
						},
					},
					createElement(Holder),
				),
			),
		);
	});
	return {state, client};
}

describe("useMutationRunner", () => {
	it("runs the mutation and its per-call callbacks without re-rendering its holder", async () => {
		const events: string[] = [];
		const {state, client} = mountRunner(async (variables) => Promise.resolve(`saved ${variables}`), events);
		const first = state.runner;
		await act(async () => {
			state.runner?.mutate("a", {
				onSuccess: (data) => {
					events.push(`call success ${data}`);
				},
				onSettled: () => {
					events.push("call settled");
				},
			});
			await pause();
		});
		expect({
			renders: state.renders,
			stable: state.runner === first,
			events,
			mutations: client
				.getMutationCache()
				.getAll()
				.map((mutation) => mutation.state.status),
		}).toStrictEqual({
			renders: 1,
			stable: true,
			events: ["options success saved a", "call success saved a", "call settled"],
			mutations: ["success"],
		});
	});

	it("rejects mutateAsync and runs onError when the mutation fails, still without a re-render", async () => {
		const events: string[] = [];
		const {state} = mountRunner(async () => Promise.reject(new Error("boom")), events);
		let rejected: unknown = null;
		await act(async () => {
			state.runner?.mutate("x", {
				onError: (error) => {
					events.push(`call error ${error.message}`);
				},
			});
			await pause();
			await state.runner?.mutateAsync("y").catch((error: unknown) => {
				rejected = error instanceof Error ? error.message : error;
			});
			await pause();
		});
		expect({renders: state.renders, rejected, events}).toStrictEqual({
			renders: 1,
			rejected: "boom",
			events: ["call error boom"],
		});
	});
});
