import {describe, expect, it} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ErrorBoundary, FatalErrorScreen} from "../src/client/components/error-boundary.js";

const match = (markup: string, re: RegExp) => re.exec(markup)?.[1];
const summarize = (markup: string) => (
{
	title: match(markup, /(<h1 class="error-boundary-title">[^<]*<\/h1>)/u),
	buttonClass: match(markup, /<button class="([^"]*)"/u),
	buttonText: match(markup, /<button[^>]*><span>([^<]*)<\/span>/u),
	detailsLabel: match(markup, /<div class="error-boundary-details-label">([^<]*)</u),
	detailsBox: match(markup, /<div class="error-boundary-details-box">([^<]*)</u),
	viewBox: match(markup, /<svg class="error-boundary-face" viewBox="([^"]*)"/u),
	hasSupportEmail: markup.includes("help@workflowy.com"),
	hasOldTitle: markup.includes("Something went wrong"),
});

describe("FatalErrorScreen", () =>
{
	it("matches the upstream fatal screen and truncates details to 200 chars", () =>
	{
		const message = "x".repeat(250);
		expect(
			summarize(
				renderToStaticMarkup(
					createElement(
						FatalErrorScreen,
						{
							message,
						},
					),
				),
			),
		).toStrictEqual(
			{
				title: '<h1 class="error-boundary-title">Something has gone wrong</h1>',
				buttonClass: "button large error-boundary-retry",
				buttonText: "Try again",
				detailsLabel: "Error details",
				detailsBox: "x".repeat(200),
				viewBox: "0 0 36 36",
				hasSupportEmail: false,
				hasOldTitle: false,
			},
		);
	});
});

describe("ErrorBoundary", () =>
{
	it("getDerivedStateFromError returns the error state", () =>
	{
		const error = new Error("boom");
		expect(ErrorBoundary.getDerivedStateFromError(error)).toStrictEqual(
			{
				hasError: true,
				error,
			},
		);
	});
});
