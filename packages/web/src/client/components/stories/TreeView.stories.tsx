import type {Meta, StoryObj} from "@storybook/react-vite";

import {StaticNode} from "./primitives.js";

const meta: Meta =
{
	title: "Compositions/TreeView",
	parameters:
	{
		layout: "padded",
	},
	decorators: [
		(Story) => (
			<div
				className="outline-view"
				style={
				{
					width: "700px",
					position: "relative",
				}}
			>
				<Story />
			</div>
		),
	],
};

export default meta;
type Story = StoryObj;

export const MultipleNestingLevels: Story =
{
	render: () => (
		<>
			<StaticNode isExpanded name="Root level item">
				<StaticNode isExpanded name="First child">
					<StaticNode isExpanded name="Grandchild item">
						<StaticNode name="Great-grandchild" />
						<StaticNode name="Another great-grandchild" />
					</StaticNode>
					<StaticNode name="Second grandchild" />
				</StaticNode>
				<StaticNode isExpanded name="Second child">
					<StaticNode name="Nested under second child" />
				</StaticNode>
			</StaticNode>
			<StaticNode name="Another root item" />
		</>
	),
};

export const MixedCompletedUncompleted: Story =
{
	render: () => (
		<StaticNode isExpanded name="Project Tasks">
			<StaticNode isCompleted name="Design mockups" />
			<StaticNode isCompleted name="Set up development environment" />
			<StaticNode name="Implement core features" />
			<StaticNode name="Write unit tests" />
			<StaticNode isCompleted name="Code review" />
			<StaticNode name="Deploy to staging" />
			<StaticNode name="User acceptance testing" />
		</StaticNode>
	),
};

export const NodesWithAndWithoutNotes: Story =
{
	render: () => (
		<>
			<StaticNode isExpanded name="Meeting Notes" note="Weekly sync with the team">
				<StaticNode name="Discuss roadmap" note="Q1 priorities: performance, new features, bug fixes" />
				<StaticNode name="Review metrics" />
				<StaticNode name="Team updates" note="Each team member shares their progress and blockers" />
				<StaticNode name="Action items" />
			</StaticNode>
			<StaticNode isExpanded name="Ideas">
				<StaticNode
					name="New feature concept"
					note="Allow users to collaborate in real-time. Need to research WebSocket implementation and consider scaling implications."
				/>
				<StaticNode name="Performance optimization" />
			</StaticNode>
		</>
	),
};

export const ComplexTree: Story =
{
	render: () => (
		<>
			<StaticNode isExpanded name='<span class="colored c-green">Work</span>'>
				<StaticNode isExpanded name="Current Sprint" note="Sprint 42: Focus on user experience improvements">
					<StaticNode isCompleted name="Fix navigation bug" />
					<StaticNode
						isEditing
						name="Implement search feature"
						note="Use fuzzy matching for better results"
					/>
					<StaticNode name="Update documentation" />
				</StaticNode>
				<StaticNode name="Backlog" />
			</StaticNode>
			<StaticNode isExpanded name='<span class="colored c-blue">Personal</span>'>
				<StaticNode isCompleted name="Morning routine" />
				<StaticNode name="Read book" note="Currently reading: System Design Interview" />
				<StaticNode isExpanded name="Groceries">
					<StaticNode isCompleted name="Milk" />
					<StaticNode isCompleted name="Bread" />
					<StaticNode name="Vegetables" />
				</StaticNode>
			</StaticNode>
		</>
	),
};

export const DeepNesting: Story =
{
	render: () => (
		<StaticNode isExpanded name="Level 0">
			<StaticNode isExpanded name="Level 1">
				<StaticNode isExpanded name="Level 2">
					<StaticNode isExpanded name="Level 3">
						<StaticNode isExpanded name="Level 4">
							<StaticNode isExpanded name="Level 5">
								<StaticNode name="Level 6 (leaf)" />
							</StaticNode>
						</StaticNode>
					</StaticNode>
				</StaticNode>
			</StaticNode>
		</StaticNode>
	),
};
