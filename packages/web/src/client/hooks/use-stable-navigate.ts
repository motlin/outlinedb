import {useLayoutEffect} from "react";
import type {ReactNode} from "react";
import {useNavigate} from "react-router-dom";
import type {NavigateFunction, NavigateOptions, To} from "react-router-dom";

let routerNavigate: NavigateFunction | undefined;

/** Forwards to the mounted router's latest navigate; its identity never changes. */
async function stableNavigate(to: To | number, options?: NavigateOptions): Promise<void>
{
	if (routerNavigate === undefined)
	{
		throw new Error("useStableNavigate needs a StableNavigateProvider inside the router");
	}
	await (typeof to === "number" ? routerNavigate(to) : routerNavigate(to, options));
}

/**
 * React Router's `useNavigate` reads the location, so every component holding it re-renders on each URL change. This
 * provider is the one component that does; `useStableNavigate` below it never re-renders its caller.
 */
export function StableNavigateProvider({children}: {children?: ReactNode}): ReactNode
{
	const navigate = useNavigate();
	useLayoutEffect(() =>
	{
		routerNavigate = navigate;
	}, [navigate]);
	return children;
}

/** A navigate that does not re-render its caller when the URL changes. Use it wherever the location is not read. */
export function useStableNavigate(): NavigateFunction
{
	return stableNavigate;
}
