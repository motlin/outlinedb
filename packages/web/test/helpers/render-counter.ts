// Installs a fake React DevTools hook that counts renders per component name, the way the Profiler does.
// React DOM looks for the hook when it loads, so a test imports this module before importing react-dom.

interface Fiber
{
	type: unknown;
	flags: number;
	actualStartTime?: number;
	child: Fiber | null;
	sibling: Fiber | null;
}

/** Renders per component name since the last `renders.clear()`. */
export const renders = new Map<string, number>();
let lastCommit = -1;
const PERFORMED_WORK = 1;

/**
 * A component's name; a memo with a compare function wraps its component in a fiber of its own, so only the
 * component's fiber counts.
 */
function componentName(type: unknown): string | undefined
{
	if (typeof type === "function")
	{
		return type.name;
	}
	if (
		typeof type === "object" &&
		type !== null &&
		"type" in type &&
		typeof type.type === "function" &&
		!("compare" in type && typeof type.compare === "function")
	)
	{
		return type.type.name;
	}
	return undefined;
}

function countRenders(start: Fiber | null): void
{
	for (let fiber = start; fiber !== null; fiber = fiber.sibling)
	{
		const name = componentName(fiber.type);
		if (name !== undefined && (fiber.flags & PERFORMED_WORK) !== 0 && (fiber.actualStartTime ?? 0) > lastCommit)
		{
			renders.set(name, (renders.get(name) ?? 0) + 1);
		}
		countRenders(fiber.child);
	}
}

Reflect.set(
	globalThis,
	"__REACT_DEVTOOLS_GLOBAL_HOOK__",
	{
		renderers: new Map(),
		supportsFiber: true,
		isDisabled: false,
		inject: () => 1,
		onScheduleFiberRoot()
		{
		},
		onCommitFiberRoot(
			_id: number,
			root:
			{
				current: Fiber;
			},
		)
		{
			countRenders(root.current.child);
			lastCommit = performance.now();
		},
		onCommitFiberUnmount()
		{
		},
		onPostCommitFiberRoot()
		{
		},
		checkDCE()
		{
		},
	},
);
