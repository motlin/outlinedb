// @vitest-environment happy-dom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {AudioPreview} from "../src/client/components/audio-preview.js";

declare global
{
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];
afterEach(() =>
{
	for (const unmount of mounted.splice(0))
	{
		unmount();
	}
});

function mount()
{
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	act(() =>
	{
		root.render(<AudioPreview nodeId="n1" fileName="tone.wav" />);
	});
	mounted.push(() =>
	{
		act(() =>
		{
			root.unmount();
		});
		host.remove();
	});
	const audio = host.querySelector("audio");
	if (audio === null)
	{
		throw new Error("no audio element");
	}
	return {
		host,
		audio,
	};
}

describe("AudioPreview", () =>
{
	it("statically renders the hidden audio and a Loading... player", () =>
	{
		const html = renderToStaticMarkup(<AudioPreview nodeId="n1" fileName="tone.wav" />);

		const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
		expect(
			{
				audio: doc.querySelector("audio")?.outerHTML,
				buttons: [...doc.querySelectorAll(".audio--player > button.button")].map((b) =>
					b.querySelector("svg")?.getAttribute("data-icon"),
				),
				label: doc.querySelector(".audio--player > div")?.textContent,
				range: doc.querySelector(".audio--player > input")?.outerHTML,
			},
		).toStrictEqual(
			{
				audio: '<audio preload="metadata" src="/api/v1/files/n1/original"></audio>',
				buttons: ["play", "download"],
				label: "Loading...",
				range: '<input type="range" max="0" name="audio-seek" value="0">',
			},
		);
	});

	it("shows current and total time and the range in milliseconds after loadeddata and timeupdate", () =>
	{
		const {host, audio} = mount();
		Object.defineProperty(
			audio,
			"duration",
			{
				value: 3,
				configurable: true,
			},
		);
		Object.defineProperty(
			audio,
			"currentTime",
			{
				value: 1.4,
				configurable: true,
				writable: true,
			},
		);

		act(() =>
		{
			audio.dispatchEvent(new Event("loadeddata"));
			audio.dispatchEvent(new Event("timeupdate"));
		});

		const range = host.querySelector<HTMLInputElement>("input[type=range]");
		expect(
			{
				label: host.querySelector(".audio--player > div")?.textContent,
				max: range?.getAttribute("max"),
				value: range?.value,
			},
		).toStrictEqual(
			{
				label: "00:01 / 00:03",
				max: "3000",
				value: "1400",
			},
		);
	});

	it("plays on the first button click and flips to the pause icon on the play event", () =>
	{
		const {host, audio} = mount();
		let paused = true;
		Object.defineProperty(
			audio,
			"paused",
			{
				get: () => paused,
				configurable: true,
			},
		);
		const play = vi.fn<() => Promise<void>>(async () =>
		{
			paused = false;
			audio.dispatchEvent(new Event("play"));
			return Promise.resolve();
		});
		audio.play = play;

		act(() =>
		{
			host.querySelector<HTMLButtonElement>(".audio--player > button")?.click();
		});

		expect(
			{
				plays: play.mock.calls.length,
				icon: host.querySelector(".audio--player > button svg")?.getAttribute("data-icon"),
			},
		).toStrictEqual(
			{
				plays: 1,
				icon: "pause",
			},
		);
	});

	it("seeks by setting currentTime from the range value in seconds", () =>
	{
		const {host, audio} = mount();
		Object.defineProperty(
			audio,
			"duration",
			{
				value: 3,
				configurable: true,
			},
		);
		Object.defineProperty(
			audio,
			"currentTime",
			{
				value: 0,
				configurable: true,
				writable: true,
			},
		);
		act(() =>
		{
			audio.dispatchEvent(new Event("loadeddata"));
		});
		const range = host.querySelector<HTMLInputElement>("input[type=range]");
		if (range === null)
		{
			throw new Error("no range");
		}

		act(() =>
		{
			// oxlint-disable-next-line typescript/unbound-method -- called with the input as `this` right below
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(range, "2500");
			range.dispatchEvent(
				new Event(
					"input",
					{
						bubbles: true,
					},
				),
			);
		});

		expect(audio.currentTime).toBe(2.5);
	});
});
