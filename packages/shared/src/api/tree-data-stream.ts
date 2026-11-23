/** The top-level values of a `/get_tree_data/` body besides its items, as sent; the caller validates them. */
export interface TreeDataRest
{
	txId: unknown;
	expandedKeys: unknown;
	loggedOut: unknown;
}

/** The root keys {@link readTreeDataBody} keeps, each small enough to parse whole; every other one is skipped unread. */
const KEPT: Readonly<Record<string, keyof TreeDataRest>> =
{
	most_recent_operation_transaction_id: "txId",
	server_expanded_projects_list: "expandedKeys",
	logged_out: "loggedOut",
};

const QUOTE = 34;
const BACKSLASH = 92;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const COLON = 58;
const COMMA = 44;

function isSpace(code: number): boolean
{
	return code === 32 || code === 10 || code === 13 || code === 9;
}

/**
 * Read a `/get_tree_data/` body (`{"items": [...], ...}`) as it arrives, handing each item of the root's `items` array
 * to `onItem` parsed on its own and awaiting it before reading on. Memory holds one network chunk and the item being
 * read, never the document. It tracks bracket depth outside strings; of the root's other keys it keeps only those of
 * {@link TreeDataRest}. Throws when the body ends before its root object closes.
 */
export async function readTreeDataBody(
	body: ReadableStream<Uint8Array>,
	onItem: (item: unknown) => void | Promise<void>,
): Promise<TreeDataRest>
{
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const rest: TreeDataRest =
	{
		txId: undefined,
		expandedKeys: undefined,
		loggedOut: undefined,
	};
	let depth = 0;
	let inString = false;
	let escaped = false;
	/** In the root object: the next string is a key, or the next character starts the key's value. */
	let expectKey = false;
	let expectValue = false;
	let key = "";
	let inItems = false;
	/** What is being read whole: a root key, a kept root value, or one item. */
	let capture: "key" | "value" | "item" | null = null;
	let captureStart = 0;
	/** The captured text from earlier chunks. */
	let pending = "";
	let closed = false;
	try
	{
		for (;;)
		{
			// oxlint-disable-next-line no-await-in-loop -- reading the body one chunk at a time is the point
			const {done, value} = await reader.read();
			const chunk = done
				? decoder.decode()
				: decoder.decode(
						value,
						{
							stream: true,
						},
					);
			const take = (end: number): string =>
			{
				const text = pending + chunk.slice(captureStart, end);
				pending = "";
				capture = null;
				return text;
			};
			const endValue = (end: number) =>
			{
				if (capture === "value")
				{
					const name = KEPT[key];
					const text = take(end);
					if (name !== undefined)
					{
						rest[name] = JSON.parse(text);
					}
				}
			};
			for (let i = 0; i < chunk.length; i++)
			{
				const code = chunk.codePointAt(i) ?? 0;
				if (inString)
				{
					if (escaped)
					{
						escaped = false;
					}
					else if (code === BACKSLASH)
					{
						escaped = true;
					}
					else if (code === QUOTE)
					{
						inString = false;
						if (capture === "key")
						{
							key = String(JSON.parse(take(i + 1)));
							expectKey = false;
						}
					}
					continue;
				}
				if (isSpace(code))
				{
					continue;
				}
				if (expectValue)
				{
					expectValue = false;
					if (key === "items" && code === OPEN_BRACKET)
					{
						inItems = true;
					}
					else if (Object.hasOwn(KEPT, key))
					{
						capture = "value";
						captureStart = i;
					}
				}
				switch (code)
				{
					case QUOTE:
					{
						inString = true;
						if (depth === 1 && expectKey)
						{
							capture = "key";
							captureStart = i;
						}
						break;
					}
					case OPEN_BRACE:
					case OPEN_BRACKET:
					{
						depth++;
						if (depth === 1)
						{
							expectKey = true;
						}
						else if (inItems && depth === 3 && code === OPEN_BRACE)
						{
							capture = "item";
							captureStart = i;
						}
						break;
					}
					case CLOSE_BRACE:
					case CLOSE_BRACKET:
					{
						if (depth === 1)
						{
							endValue(i);
							closed = true;
						}
						depth--;
						if (capture === "item" && depth === 2)
						{
							// oxlint-disable-next-line no-await-in-loop -- each item is handed over before the next is read
							await onItem(JSON.parse(take(i + 1)));
						}
						else if (inItems && depth === 1)
						{
							inItems = false;
						}
						break;
					}
					case COLON:
					{
						expectValue = depth === 1;
						break;
					}
					case COMMA:
					{
						if (depth === 1)
						{
							endValue(i);
							expectKey = true;
						}
						break;
					}
					default:
					{
						break;
					}
				}
			}
			if (capture !== null)
			{
				pending += chunk.slice(captureStart);
				captureStart = 0;
			}
			if (done)
			{
				break;
			}
		}
	}
	finally
	{
		await reader.cancel().catch(() => {});
	}
	if (!closed)
	{
		throw new SyntaxError("the /get_tree_data/ body ended before its root object closed");
	}
	return rest;
}
