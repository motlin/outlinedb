import {describe, expect, it} from "vite-plus/test";
import {renderToStaticMarkup} from "react-dom/server";
import {expandArrow} from "../src/client/components/expand-arrow.js";

type Click = (event: {preventDefault: () => void; stopPropagation: () => void; timeStamp: number}) => void;

function setup(overrides: Partial<Parameters<typeof expandArrow>[0]> = {})
{
	const calls: [string, string][] = [];
	const element = expandArrow(
		{
			nodeId: "a",
			hasChildren: true,
			isExpanded: false,
			alwaysVisible: true,
			onToggle: (id) =>
			{
				calls.push(["toggle", id]);
			},
			onExpandAll: (id) =>
			{
				calls.push(["all", id]);
			},
			onFocusRow: (id) =>
			{
				calls.push(["focus", id]);
			},
			...overrides,
		},
	);
	const props = element.props as
	{
		onClick: Click;
		onMouseDown?: (event: {preventDefault: () => void}) => void;
	};
	return {
		element,
		props,
		calls,
	};
}

const click = (
	props:
	{
		onClick: Click;
	},
	timeStamp = 1000,
): void =>
{
	props.onClick(
		{
			preventDefault()
			{
			},
			stopPropagation()
			{
			},
			timeStamp,
		},
	);
};

describe("expandArrow", () =>
{
	it("puts the caret at the row start after toggling", () =>
	{
		const {props, calls} = setup();
		click(props);
		expect(calls).toStrictEqual([
			["toggle", "a"],
			["focus", "a"],
		]);
	});

	it("does not focus the row for a leaf", () =>
	{
		const {props, calls} = setup(
			{
				hasChildren: false,
				nodeId: "leaf",
			},
		);
		click(props, 5000);
		expect(calls).toStrictEqual([]);
	});

	it("does not focus the row where expanding all is unavailable (search)", () =>
	{
		const {props, calls} = setup(
			{
				onExpandAll: undefined,
				nodeId: "searched",
			},
		);
		click(props, 9000);
		expect(calls).toStrictEqual([["toggle", "searched"]]);
	});

	it("keeps mousedown from moving focus to the button", () =>
	{
		const {props} = setup();
		let prevented = false;
		props.onMouseDown?.(
			{
				preventDefault()
				{
					prevented = true;
				},
			},
		);
		expect(prevented).toBe(true);
	});

	it("draws the arrow in quinary while the controls are always visible, transparent otherwise", () =>
	{
		const style = (alwaysVisible: boolean): string | undefined =>
			/style="([^"]*)"/u.exec(
				renderToStaticMarkup(
					setup(
						{
							alwaysVisible,
						},
					).element,
				),
			)?.[1];
		expect([style(true), style(false)]).toStrictEqual(["color:var(--wf-text-quinary)", "color:transparent"]);
	});
});
