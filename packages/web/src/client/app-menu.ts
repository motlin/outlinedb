/**
 * Upstream's config-driven menu engine: a port of `WF.AppMenu.assemble` (`xY2`),
 * `assembleFlatForId` (`bY2`) and the qualifier builders `AppItemMenu.qualify` (`wY2`)
 * and `AppMultiSelect.qualify` (`FY2`). Pure; the command lookup supplies availability.
 */

/** Set keys are `"<menu> :: <qualifier>"`; an active set lists the ids that menu shows, a block set the ids it hides. */
export interface MenuConfig
{
	orderedUi: Record<string, readonly (readonly [string, boolean])[]>;
	isSubmenu: ReadonlySet<string>;
	activeSets: Record<string, readonly string[]>;
	blockSets: Record<string, readonly string[]>;
	labels: Record<string, string>;
	icons: Record<string, string>;
}

export type AssembledEntry<C> =
	|
	  {
			kind: "command";
			id: string;
			cmd: C;
	  }
	|
	  {
			kind: "submenu";
			id: string;
	  }
	|
	  {
			kind: "separator";
	  };

type Lookup<C> = (id: string) => C | null;

type StackItem =
	|
	  {
			kind: "key";
			id: string;
			flag: boolean;
	  }
	|
	  {
			kind: "group_end";
	  };

function isGroup(id: string, config: MenuConfig): boolean
{
	return config.orderedUi[id] !== undefined && !config.isSubmenu.has(id);
}

function blockedIds(menuId: string, qualifiers: Iterable<string>, config: MenuConfig): Set<string>
{
	const blocked = new Set<string>();
	for (const qualifier of qualifiers)
	{
		for (const id of config.blockSets[`${menuId} :: ${qualifier}`] ?? [])
		{
			blocked.add(id);
		}
	}
	return blocked;
}

function entryFor<C>(id: string, cmd: C, config: MenuConfig): AssembledEntry<C>
{
	return config.isSubmenu.has(id)
		?
			{
				kind: "submenu",
				id,
			}
		:
			{
				kind: "command",
				id,
				cmd,
			};
}

/**
 * The first qualifier with an active set initializes the allowed ids; each later one intersects.
 * Null means no active set applies; an empty array means the menu shows nothing.
 */
function allowedIds(menuId: string, qualifiers: readonly string[], config: MenuConfig): string[] | null
{
	let allowed: string[] | null = null;
	for (const qualifier of qualifiers)
	{
		const active = config.activeSets[`${menuId} :: ${qualifier}`];
		if (active === undefined)
		{
			continue;
		}
		allowed = allowed === null ? [...active] : allowed.filter((id) => active.includes(id));
	}
	return allowed;
}

export function assembleMenu<C>(
	menuId: string,
	qualifiers: Iterable<string>,
	lookup: Lookup<C>,
	config: MenuConfig,
): AssembledEntry<C>[]
{
	const order = config.orderedUi[menuId];
	if (order === undefined)
	{
		return [];
	}
	const qualifierList = [...qualifiers];
	const allowed = allowedIds(menuId, qualifierList, config);
	const blocked = blockedIds(menuId, qualifierList, config);
	const entries: AssembledEntry<C>[] = [];
	const emitted = new Set<string>();
	const visitedGroups = new Set<string>();
	let groupStart = false;

	const emit = (id: string, cmd: C): void =>
	{
		if (entries.length > 0 && groupStart)
		{
			entries.push(
				{
					kind: "separator",
				},
			);
		}
		groupStart = false;
		entries.push(entryFor(id, cmd, config));
		emitted.add(id);
	};

	const stack: StackItem[] = order.toReversed().map(([id, flag]) => (
	{
		kind: "key",
		id,
		flag,
	}));
	for (let item = stack.pop(); item !== undefined; item = stack.pop())
	{
		if (item.kind === "group_end")
		{
			groupStart = true;
			continue;
		}
		const {id, flag} = item;
		if (isGroup(id, config))
		{
			if (!flag || visitedGroups.has(id))
			{
				continue;
			}
			visitedGroups.add(id);
			stack.push(
				{
					kind: "group_end",
				},
			);
			for (const [childId, childFlag] of (config.orderedUi[id] ?? []).toReversed())
			{
				stack.push(
					{
						kind: "key",
						id: childId,
						flag: childFlag,
					},
				);
			}
			groupStart = true;
			continue;
		}
		if (emitted.has(id) || blocked.has(id))
		{
			continue;
		}
		const keep = allowed === null ? flag : allowed.includes(id);
		if (!keep)
		{
			continue;
		}
		const cmd = lookup(id);
		if (cmd !== null)
		{
			emit(id, cmd);
		}
	}

	let leftoverSeparator = entries.length > 0;
	for (const id of allowed ?? [])
	{
		if (emitted.has(id) || blocked.has(id) || isGroup(id, config))
		{
			continue;
		}
		const cmd = lookup(id);
		if (cmd === null)
		{
			continue;
		}
		if (leftoverSeparator)
		{
			entries.push(
				{
					kind: "separator",
				},
			);
			leftoverSeparator = false;
		}
		entries.push(entryFor(id, cmd, config));
		emitted.add(id);
	}
	return entries;
}

/** Block sets only, no separators and no group expansion: the rows of a submenu. */
export function assembleFlatForId<C>(
	menuId: string,
	qualifiers: Iterable<string>,
	lookup: Lookup<C>,
	config: MenuConfig,
): AssembledEntry<C>[]
{
	const blocked = blockedIds(menuId, qualifiers, config);
	const entries: AssembledEntry<C>[] = [];
	for (const [id, flag] of config.orderedUi[menuId] ?? [])
	{
		if (!flag || blocked.has(id) || config.orderedUi[id] !== undefined)
		{
			continue;
		}
		const cmd = lookup(id);
		if (cmd !== null)
		{
			entries.push(
				{
					kind: "command",
					id,
					cmd,
				},
			);
		}
	}
	return entries;
}

interface QualifiableNode
{
	isOriginalNotFound?: boolean;
	readOnly?: boolean;
	isMainDocumentRoot?: boolean;
	data:
	{
		layoutMode: string | null;
	};
}

/** `AppItemMenu.qualify`: `extra` carries the listener qualifiers (`is_inside_side_pane`, `is_comment`, `is_table_*_cell`...). */
export function qualifyItemMenu(node: QualifiableNode, extra: readonly string[] = []): string[]
{
	if (node.isOriginalNotFound === true)
	{
		return ["is_dangling"];
	}
	const qualifiers = [...extra, `is_${(node.data.layoutMode ?? "bullets").replaceAll("-", "_")}`];
	if (node.readOnly === true && node.isMainDocumentRoot !== true)
	{
		qualifiers.push("is_readonly");
	}
	if (qualifiers.includes("is_comment") && !qualifiers.includes("is_draft"))
	{
		qualifiers.push("is_comment_not_draft");
	}
	return qualifiers;
}

/** `AppMultiSelect.qualify`: pane and table-cell listeners. */
export function qualifyMultiSelect(
	itemIds: readonly string[],
	{
		inSidePane,
		isTableCell,
	}:
	{
		inSidePane: (id: string) => boolean;
		isTableCell: (id: string) => boolean;
	},
): string[]
{
	const qualifiers: string[] = [];
	if (itemIds.some((id) => inSidePane(id)))
	{
		qualifiers.push("has_pane_item");
	}
	if (itemIds.some((id) => isTableCell(id)))
	{
		qualifiers.push("has_table_cell");
	}
	return qualifiers;
}
