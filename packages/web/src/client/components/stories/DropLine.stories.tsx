import type {Meta, StoryObj} from "@storybook/react-vite";

import {DropLine} from "./primitives.js";

const meta: Meta<typeof DropLine> =
{
	title: "Primitives/DropLine",
	component: DropLine,
	parameters:
	{
		layout: "padded",
	},
	tags: ["autodocs"],
	argTypes:
	{
		isVisible:
		{
			control: "boolean",
			description: "Whether the drop line is visible",
		},
	},
	decorators: [
		(Story) => (
			<div
				style={
				{
					width: "400px",
					padding: "20px 0",
				}}
			>
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Visible: Story =
{
	args:
	{
		isVisible: true,
	},
};

export const Hidden: Story =
{
	args:
	{
		isVisible: false,
	},
};
