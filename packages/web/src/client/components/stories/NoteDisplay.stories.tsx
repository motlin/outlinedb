import type {Meta, StoryObj} from "@storybook/react-vite";
import {NoteDisplay} from "./primitives.js";

const meta: Meta<typeof NoteDisplay> =
{
	title: "Components/NoteDisplay",
	component: NoteDisplay,
	parameters:
	{
		layout: "padded",
	},
	tags: ["autodocs"],
	argTypes:
	{
		content:
		{
			control: "text",
			description: "HTML content of the note",
		},
		isActive:
		{
			control: "boolean",
			description: "Whether the note is focused, which unclamps it",
		},
	},
	decorators: [
		(Story) => (
			<div
				className="noted"
				style={
				{
					width: "400px",
				}}
			>
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const UnfocusedShort: Story =
{
	args:
	{
		content: "A brief note about this item.",
		isActive: false,
	},
};

export const UnfocusedLong: Story =
{
	args:
	{
		content:
			"This is a much longer note that contains multiple lines of text. It demonstrates how notes are truncated when collapsed. The note continues with more details about the item, including background information, context, and additional considerations that might be relevant.",
		isActive: false,
	},
};

export const ActiveShort: Story =
{
	args:
	{
		content: "A brief note about this item.",
		isActive: true,
	},
};

export const ActiveLong: Story =
{
	args:
	{
		content:
			"This is a much longer note that contains multiple lines of text. It demonstrates how notes are truncated when collapsed. The note continues with more details about the item, including background information, context, and additional considerations that might be relevant.",
		isActive: true,
	},
};

export const WithHTML: Story =
{
	args:
	{
		content: '<b>Important:</b> This note contains <em>formatted text</em> and a <a href="#">link</a>.',
		isActive: true,
	},
};

export const WithLineBreaks: Story =
{
	args:
	{
		content: "First line of the note.<br/>Second line with more details.<br/>Third line concluding the thought.",
		isActive: true,
	},
};

export const Empty: Story =
{
	args:
	{
		content: "",
		isActive: false,
	},
};
