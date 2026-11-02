import type {Meta, StoryObj} from "@storybook/react-vite";
import {fn} from "storybook/test";

import {StaticNode} from "./primitives.js";

/**
 * Stories covering the block layouts driven by `metadata.layoutMode`
 * (h1/h2/h3, to-do, code-block, quote-block, divider). Each maps to a class on
 * the `.project` element; see `.llm/web/node-type-coverage.md` for the upstream
 * capture these styles mirror.
 */
const meta: Meta<typeof StaticNode> =
{
	title: "Components/BlockLayouts",
	component: StaticNode,
	parameters:
	{
		layout: "padded",
	},
	tags: ["autodocs"],
	argTypes:
	{
		layoutMode:
		{
			control: "select",
			options: ["bullets", "h1", "h2", "h3", "todo", "code-block", "quote-block", "divider", "numbered", "board"],
			description: "The metadata.layoutMode block type",
		},
		name:
		{
			control: "text",
		},
		isCompleted:
		{
			control: "boolean",
		},
	},
	args:
	{
		onToggleExpand: fn<() => void>(),
		isExpanded: false,
		isCompleted: false,
	},
	decorators: [
		(Story) => (
			<div
				style={
				{
					width: "600px",
					position: "relative",
					minHeight: "50px",
				}}
			>
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Heading1: Story =
{
	args:
	{
		name: "A level-one heading",
		layoutMode: "h1",
	},
};

export const Heading2: Story =
{
	args:
	{
		name: "A level-two heading",
		layoutMode: "h2",
	},
};

export const Heading3: Story =
{
	args:
	{
		name: "A level-three heading",
		layoutMode: "h3",
	},
};

export const TodoUnchecked: Story =
{
	args:
	{
		name: "An open to-do item",
		layoutMode: "todo",
		isCompleted: false,
	},
};

export const TodoChecked: Story =
{
	args:
	{
		name: "A completed to-do item",
		layoutMode: "todo",
		isCompleted: true,
	},
};

export const CodeBlock: Story =
{
	args:
	{
		name: "const answer = 42;",
		layoutMode: "code-block",
	},
};

export const QuoteBlock: Story =
{
	args:
	{
		name: "A quoted passage rendered with a left bar.",
		layoutMode: "quote-block",
	},
};

export const Divider: Story =
{
	args:
	{
		name: "",
		layoutMode: "divider",
	},
};
