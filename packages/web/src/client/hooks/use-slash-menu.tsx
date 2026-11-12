import {useQueryClient} from "@tanstack/react-query";
import {useMemo} from "react";
import type {ReactNode} from "react";
import {SlashMenu} from "../components/slash-menu.js";
import type {CommandContext} from "../keys/dispatch.js";
import {LOCAL_SLASH_AVAILABLE, resolveSlash} from "../slash-commands.js";
import type {SlashCommandKey, SlashCommandOption, SlashGroup, SlashMathOption} from "../slash-commands.js";
import {evalMath} from "../slash-math.js";
import {planSlashOpen, planSlashRearm, SLASH_CHIP_CLASS} from "../slash-trigger.js";
import type {SuggestClient, SuggestInputResult} from "./use-suggest.js";
import {useSuggest} from "./use-suggest.js";
import {useOutlineStore} from "../stores/outline.js";
import {activeCommandRegistry} from "./use-global-keymap.js";
import {markSlashDiscovered} from "./use-preferences.js";

interface SlashMenuOptions
{
	editorRef: React.RefObject<HTMLElement | null>;
	/** The row the editor belongs to: the command's item. */
	nodeId: string;
	/** The editor's text changed outside a native input (the chip was unwrapped or replaced by a math result). */
	onChange: () => void;
	/** Save the editor's text now, before a command runs. */
	onSave: () => void;
}

type SlashOption = SlashCommandOption | SlashMathOption;

function flatOptions(groups: readonly SlashGroup[]): SlashOption[]
{
	return groups.flatMap((group): SlashOption[] => group.options);
}

/** A slash command is offered when it has a local executor and the active registry can run it on this row. */
function commandContext(nodeId: string): CommandContext
{
	return {
		items: [nodeId],
		zoomedId: useOutlineStore.getState().zoomedNodeId,
	};
}

function resolve(chipText: string, nodeId: string): SlashGroup[] | null
{
	if (!chipText.trimStart().startsWith("/"))
	{
		return null;
	}
	const registry = activeCommandRegistry();
	const ctx = commandContext(nodeId);
	const groups = resolveSlash(
		chipText,
		{
			available: (key) =>
			{
				const command = registry[key];
				return LOCAL_SLASH_AVAILABLE(key) && command !== undefined && command.available?.(ctx) !== false;
			},
			evalMath,
		},
	);
	return groups !== null && flatOptions(groups).length > 0 ? groups : null;
}

/**
 * Upstream's slash input (`qU4`): a `WF.Suggest` client with prefix `/`, strict. Typing a first or standalone `/`
 * wraps it in the `slash-input` chip and opens the command menu under it. See `useSuggest` for the contract.
 */
export function useSlashMenu({editorRef, nodeId, onChange, onSave}: SlashMenuOptions):
{
	handleInput: (event?: Event) => SuggestInputResult;
	handleKeyDown: (event: React.KeyboardEvent) => boolean;
	isOpen: () => boolean;
	detach: () => void;
	refresh: () => void;
	menu: ReactNode;
}
{
	const queryClient = useQueryClient();
	const client: SuggestClient<SlashGroup[], SlashOption> = useMemo(
		() => (
		{
			opts:
			{
				prefix: "/",
				strict: true,
				chipClassName: SLASH_CHIP_CLASS,
			},
			planOpen: planSlashOpen,
			planRearm: planSlashRearm,
			search: (chipText) => resolve(chipText, nodeId),
			count: (groups) => flatOptions(groups).length,
			option: (groups, index) => flatOptions(groups)[index],
			// A failed PATCH rolls the flag back; the hint just stays until the next open.
			onArm: () =>
			{
				markSlashDiscovered(queryClient).catch(() => {});
			},
			onChange,
			select: (option, {replaceChip, anchorRect}) =>
			{
				if (!("key" in option))
				{
					if (option.noop !== true)
					{
						replaceChip(option.label);
						onChange();
					}
					return;
				}
				replaceChip("");
				onSave();
				const key: SlashCommandKey = option.key;
				const ctx: CommandContext =
				{
					...commandContext(nodeId),
					anchorRect,
				};
				globalThis.requestAnimationFrame(() =>
				{
					const command = activeCommandRegistry()[key];
					if (command !== undefined && command.available?.(ctx) !== false)
					{
						command.execute(ctx);
					}
				});
			},
			renderMenu: (props) => (
				<SlashMenu
					groups={props.groups}
					index={props.index}
					keyboardMode={props.keyboardMode}
					left={props.left}
					top={props.top}
					onSelect={props.onSelect}
					onHover={props.onHover}
					onMouseMove={props.onMouseMove}
				/>
			),
		}),
		[nodeId, onChange, onSave, queryClient],
	);
	return useSuggest(
		{
			editorRef,
			client,
		},
	);
}
