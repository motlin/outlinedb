// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement, useEffect} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {useCopyLink} = await import("../src/client/hooks/use-item-actions.js");
const {nodeKeys} = await import("../src/client/node-cache.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

let root: Root | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	vi.unstubAllGlobals();
});

function node(id: string, originalNodeId: string | null)
{
	return {
		id,
		parent_id: null,
		name: "x",
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		isMirror: originalNodeId !== null,
		originalNodeId,
	};
}

async function copy(nodeId: string, nodes: ReturnType<typeof node>[])
{
	const writeText = vi.fn<(text: string) => Promise<void>>(async () => Promise.resolve());
	vi.stubGlobal(
		"navigator",
		{
			clipboard:
			{
				writeText,
			},
		},
	);
	const showAppMessage = vi.fn<(text: string, options?: unknown) => void>();
	useOutlineStore.setState(
		{
			showAppMessage: (text, options) =>
			{
				showAppMessage(text, options);
			},
		},
	);
	const client = new QueryClient();
	for (const entry of nodes)
	{
		client.setQueryData(nodeKeys.detail(entry.id), entry);
	}
	let run: ((id: string) => Promise<void>) | undefined;
	function Probe({onReady}: {onReady: (copy: (id: string) => Promise<void>) => void})
	{
		const copyLink = useCopyLink();
		useEffect(() =>
		{
			onReady(copyLink);
		}, [copyLink, onReady]);
		return null;
	}
	root = createRoot(document.createElement("div"));
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client,
				},
				createElement(
					Probe,
					{
						onReady: (copyLink) =>
						{
							run = copyLink;
						},
					},
				),
			),
		);
	});
	await act(async () =>
	{
		await run?.(nodeId);
	});
	return {
		copied: writeText.mock.calls.map(([text]) => text),
		toasts: showAppMessage.mock.calls,
	};
}

describe("copy_link", () =>
{
	it("copies the original's url for a mirror row, with the Link copied toast", async () =>
	{
		const result = await copy("00000000-0000-4000-8000-00000000aaaa", [
			node("00000000-0000-4000-8000-00000000aaaa", "00000000-0000-4000-8000-c4f7c5bca489"),
		]);

		expect(result).toStrictEqual(
			{
				copied: ["https://workflowy.com/#/c4f7c5bca489"],
				toasts: [
					[
						"Link copied.",
						{
							timeout: 1000,
						},
					],
				],
			},
		);
	});

	it("copies the row's own url when it is not a mirror", async () =>
	{
		const result = await copy("00000000-0000-4000-8000-81df3e9581ea", [
			node("00000000-0000-4000-8000-81df3e9581ea", null),
		]);

		expect(result.copied).toStrictEqual(["https://workflowy.com/#/81df3e9581ea"]);
	});
});
