import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type * as IconButtonModule from "../src/client/components/icon-button.js";

const STAR_PATH =
	"M9.278,3.513 C9.568,2.906 10.432,2.906 10.722,3.513 L12.261,6.739 C12.378,6.983 12.61,7.152 12.879,7.187 L16.422,7.654 C17.089,7.742 17.356,8.564 16.868,9.028 L14.276,11.488 C14.08,11.675 13.991,11.948 14.04,12.214 L14.691,15.728 C14.813,16.39 14.114,16.898 13.523,16.577 L10.382,14.872 C10.144,14.743 9.856,14.743 9.618,14.872 L6.477,16.577 C5.886,16.898 5.187,16.39 5.309,15.728 L5.96,12.214 C6.009,11.948 5.92,11.675 5.724,11.488 L3.132,9.028 C2.644,8.564 2.911,7.742 3.578,7.654 L7.121,7.187 C7.39,7.152 7.622,6.983 7.739,6.739 L9.278,3.513 Z";

const starState:
{
	keys: string[];
	unavailable: boolean;
} =
{
	keys: [],
	unavailable: false,
};
const toggleStar = vi.fn<(loc: {nodeId: string | null; query: string | null}) => Promise<boolean>>(async () =>
	Promise.resolve(true),
);

vi.mock("../src/client/hooks/use-starred.js", () => (
{
	STARS_UNAVAILABLE_TOOLTIP: "Stars need a workflowy.com login",
	useStarActions: () => (
	{
		toggleStar,
	}),
	useStars: () => (
	{
		stars: starState.keys.map((key) => (
		{
			key,
		})),
		unavailable: starState.unavailable,
	}),
}));

const storeState =
{
	zoomedNodeId: "bob" as string | null,
	urlSearchQuery: "#todo" as string | null,
};
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

type IconButtonProps = Parameters<typeof IconButtonModule.IconButton>[0];
const captured:
{
	props?: IconButtonProps;
} = {};
vi.mock("../src/client/components/icon-button.js", async (importOriginal) =>
{
	const actual = await importOriginal<typeof IconButtonModule>();
	return {
		...actual,
		IconButton: (props: IconButtonProps) =>
		{
			captured.props = props;
			return actual.IconButton(props);
		},
	};
});

const {StarButton} = await import("../src/client/components/star-button.js");

function render(props: Parameters<typeof StarButton>[0]): string
{
	return renderToStaticMarkup(createElement(StarButton, props));
}

describe("StarButton", () =>
{
	it("renders upstream's unstarred lg markup", () =>
	{
		starState.keys = [];
		expect(
			render(
				{
					nodeId: "alice",
					handbook: "starring.star",
					size: "lg",
				},
			),
		).toBe(
			`<div role="button" tabindex="0" data-handbook="starring.star" class="starring-star iconButton lg shape-circle"><span><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="${STAR_PATH}" stroke="currentColor" fill="none"></path></svg></span></div>`,
		);
	});

	it("colors and fills the star when the location is starred", () =>
	{
		starState.keys = ["alice"];
		const html = render(
			{
				nodeId: "alice",
				handbook: "starring.star",
				size: "lg",
			},
		);
		expect(
			{
				span: html.includes('<span style="color:var(--wf-text-spark)">'),
				fill: html.includes('fill="currentColor"'),
				tooltip: captured.props?.tooltip,
			},
		).toStrictEqual(
			{
				span: true,
				fill: true,
				tooltip: "Unstar",
			},
		);
		starState.keys = [];
	});

	it("defaults to ms size and a Star tooltip without a shortcut", () =>
	{
		const html = render(
			{
				nodeId: "alice",
			},
		);
		expect(
			{
				className: /class="([^"]*)"/u.exec(html)?.[1],
				tooltip: captured.props?.tooltip,
				shortcut: captured.props?.shortcut,
			},
		).toStrictEqual(
			{
				className: "starring-star iconButton ms shape-circle",
				tooltip: "Star",
				shortcut: undefined,
			},
		);
	});

	it("toggles the node's page location on click", () =>
	{
		toggleStar.mockClear();
		render(
			{
				nodeId: "alice",
			},
		);
		captured.props?.onClick?.({} as never);
		expect(toggleStar.mock.calls).toStrictEqual([
			[
				{
					nodeId: "alice",
					query: null,
				},
			],
		]);
	});

	it("targets the zoomed node and committed query when nodeId is undefined", () =>
	{
		toggleStar.mockClear();
		render({});
		captured.props?.onClick?.({} as never);
		expect(toggleStar.mock.calls).toStrictEqual([
			[
				{
					nodeId: "bob",
					query: "#todo",
				},
			],
		]);
	});

	it("shows the unavailable tooltip and skips the toggle when stars are unavailable", () =>
	{
		toggleStar.mockClear();
		starState.unavailable = true;
		render(
			{
				nodeId: "alice",
			},
		);
		captured.props?.onClick?.({} as never);
		expect(
			{
				tooltip: captured.props?.tooltip,
				calls: toggleStar.mock.calls.length,
			},
		).toStrictEqual(
			{
				tooltip: "Stars need a workflowy.com login",
				calls: 0,
			},
		);
		starState.unavailable = false;
	});
});
