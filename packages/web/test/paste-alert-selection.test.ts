// @vitest-environment happy-dom
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import {describe, expect, it, vi} from "vite-plus/test";
import {AlertDialogView} from "../src/client/components/alert-dialog.js";
import {listenForSelectionPaste} from "../src/client/item-selection.js";

describe("AlertDialogView", () =>
{
	it("renders upstream's alert markup", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				AlertDialogView,
				{
					title: "Error",
					message: "Pasting more than 10000 items at a time is not supported.",
					onClose: () =>
					{
					},
				},
			),
		);
		expect(html).toContain('style="z-index:600"');
		expect(html).toContain("dialog-backdrop");
		expect(html).toContain(" p-xl ");
		expect(html).toContain(
			'<h1 class="title text-l leading-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis mr-3xl">Error</h1>',
		);
		expect(html).toContain(
			'<div class="text-base leading-base ">Pasting more than 10000 items at a time is not supported.</div>',
		);
		expect(html).toContain("position:absolute;top:30px;right:30px");
	});
});

describe("listenForSelectionPaste", () =>
{
	function paste(target: HTMLElement): Event
	{
		const event = new Event(
			"paste",
			{
				bubbles: true,
				cancelable: true,
			},
		);
		target.dispatchEvent(event);
		return event;
	}

	it("swallows a paste while items are selected", () =>
	{
		const stop = listenForSelectionPaste(document, () => true);
		const reached = vi.fn<() => void>();
		document.body.addEventListener("paste", reached);
		const event = paste(document.body);
		expect(event.defaultPrevented).toBe(true);
		expect(reached).not.toHaveBeenCalled();
		document.body.removeEventListener("paste", reached);
		stop();
	});

	it("leaves a paste alone without a selection", () =>
	{
		const stop = listenForSelectionPaste(document, () => false);
		expect(paste(document.body).defaultPrevented).toBe(false);
		stop();
	});

	it("leaves a paste into an input alone", () =>
	{
		const stop = listenForSelectionPaste(document, () => true);
		const input = document.createElement("input");
		document.body.append(input);
		expect(paste(input).defaultPrevented).toBe(false);
		input.remove();
		stop();
	});
});
