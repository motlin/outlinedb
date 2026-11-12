// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {focusedSidePaneId} from "../src/client/left-bar-pane-nav.js";
import {useOutlineStore} from "../src/client/stores/outline.js";

afterEach(() =>
{
	useOutlineStore.getState().closeAllPanes();
	document.body.innerHTML = "";
});

describe("focusedSidePaneId", () =>
{
	it("is null with no pane open", () =>
	{
		expect(focusedSidePaneId()).toBeNull();
	});

	it("is the active side pane", () =>
	{
		const id = useOutlineStore.getState().openPane("alice");
		expect(focusedSidePaneId()).toBe(id);
	});

	it("prefers the pane holding the focused element", () =>
	{
		const first = useOutlineStore.getState().openPane("alice");
		const second = useOutlineStore.getState().openPane("bob");
		document.body.innerHTML = `<div data-pane-id="${first}"><input id="x"></div>`;
		document.querySelector<HTMLInputElement>("#x")?.focus();
		expect(
			{
				focused: focusedSidePaneId(),
				active: useOutlineStore.getState().activePaneId,
			},
		).toStrictEqual(
			{
				focused: first,
				active: second,
			},
		);
	});

	it("is null when the main pane holds the focus", () =>
	{
		useOutlineStore.getState().openPane("alice");
		document.body.innerHTML = '<div data-pane-id="main"><input id="x"></div>';
		document.querySelector<HTMLInputElement>("#x")?.focus();
		expect(focusedSidePaneId()).toBeNull();
	});
});
