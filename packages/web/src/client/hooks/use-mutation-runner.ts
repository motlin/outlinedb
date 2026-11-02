import {MutationObserver, useQueryClient} from "@tanstack/react-query";
import type {MutateOptions, MutationObserverOptions} from "@tanstack/react-query";
import {useCallback, useEffect, useLayoutEffect, useMemo, useState} from "react";

export interface MutationRunner<TData, TVariables, TContext>
{
	/** Runs the mutation; a failure goes to the options' and the call's `onError`, never thrown. */
	mutate: (variables: TVariables, options?: MutateOptions<TData, Error, TVariables, TContext>) => void;
	mutateAsync: (variables: TVariables, options?: MutateOptions<TData, Error, TVariables, TContext>) => Promise<TData>;
}

/**
 * `useMutation` without its render subscription: its holder only runs mutations and never reads their state, so
 * each pending and settled transition would re-render it (the command registry's leaf and every editor) for nothing.
 * The observer keeps a no-op listener, which TanStack needs to call a `mutate` call's own callbacks.
 */
export function useMutationRunner<TData, TVariables, TContext>(
	options: MutationObserverOptions<TData, Error, TVariables, TContext>,
): MutationRunner<TData, TVariables, TContext>
{
	const queryClient = useQueryClient();
	const [observer] = useState(() => new MutationObserver(queryClient, options));
	useLayoutEffect(() =>
	{
		observer.setOptions(options);
	}, [observer, options]);
	useEffect(
		() =>
			observer.subscribe(() =>
			{
				// Only so that `observer.hasListeners()` holds: per-call callbacks need a listener.
			}),
		[observer],
	);
	const mutateAsync = useCallback<MutationRunner<TData, TVariables, TContext>["mutateAsync"]>(
		async (variables, mutateOptions) => observer.mutate(variables, mutateOptions),
		[observer],
	);
	const mutate = useCallback<MutationRunner<TData, TVariables, TContext>["mutate"]>(
		(variables, mutateOptions) =>
		{
			observer.mutate(variables, mutateOptions).catch(() => {});
		},
		[observer],
	);
	return useMemo(
		() => (
		{
			mutate,
			mutateAsync,
		}),
		[mutate, mutateAsync],
	);
}
