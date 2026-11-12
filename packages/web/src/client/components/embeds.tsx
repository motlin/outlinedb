import {useEffect, useRef} from "react";
import type {ReactNode} from "react";

export interface EmbedFlags
{
	ignoreYoutube: boolean;
	ignoreYtShort: boolean;
	ignoreTwitter: boolean;
	ignoreLoom: boolean;
}

export type Embed =
	|
	  {
			kind: "youtube" | "yt_short" | "loom";
			src: string;
			aspectRatio: "16 / 9" | "9 / 16";
	  }
	|
	  {
			kind: "twitter";
			tweetId: string;
	  };

// Upstream's regexes, verbatim.
const YOUTUBE =
	/(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch|v|embed|shorts)(?:\.php)?(?:\?.*v=|\/))([a-zA-Z0-9_-]+)/u;
const TWEET = /https?:\/\/(twitter|x)\.com\/(?:#!\/)?(\w+)\/status(es)?\/(\d+)/u;
const SHORTS_PREFIXES = ["https://youtube.com/shorts/", "https://www.youtube.com/shorts/"];
const LOOM_SHARE = "https://www.loom.com/share/";

/**
 * Which embed a link gets, trying upstream's handlers in order: youtube, twitter, loom, yt_short. The youtube regex also
 * matches `/shorts/`, so it wins for Shorts links unless YouTube embeds are ignored. A flag set turns its handler off.
 */
export function embedFor(href: string, flags: EmbedFlags): Embed | null
{
	const youtube = flags.ignoreYoutube ? null : YOUTUBE.exec(href);
	if (youtube?.[1] !== undefined)
	{
		return {
			kind: "youtube",
			src: `https://beta.workflowy.com/media/youtube.html?v=${youtube[1]}`,
			aspectRatio: "16 / 9",
		};
	}
	const tweet = flags.ignoreTwitter ? null : TWEET.exec(href);
	if (tweet?.[4] !== undefined)
	{
		return {
			kind: "twitter",
			tweetId: tweet[4],
		};
	}
	if (!flags.ignoreLoom && href.startsWith(LOOM_SHARE))
	{
		return {
			kind: "loom",
			src: href.replace("/share/", "/embed/"),
			aspectRatio: "16 / 9",
		};
	}
	if (!flags.ignoreYtShort && SHORTS_PREFIXES.some((prefix) => href.startsWith(prefix)))
	{
		return {
			kind: "yt_short",
			src: href.replace("shorts", "embed"),
			aspectRatio: "9 / 16",
		};
	}
	return null;
}

/** Only the first link in a row's name counts. Returns its href, or null. */
export function firstLinkHref(nameHtml: string | null): string | null
{
	const match = /<a\s[^>]*href="([^"]*)"/u.exec(nameHtml ?? "");
	return match?.[1] === undefined ? null : match[1].replaceAll("&amp;", "&");
}

/** The embeds run their own scripts from their own origin, so they get everything but top navigation and forms. */
const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox";

const FRAME_CLASS =
	"relative max-w-[540px] h-full aspect-[16/9] overflow-hidden [&>iframe]:absolute [&>iframe]:inset-0 [&>iframe]:w-full [&>iframe]:h-full [&>iframe]:border-0 embed";

interface TwitterWindow extends Window
{
	twttr?:
	{
		widgets:
		{
			createTweet: (id: string, el: HTMLElement) => Promise<unknown>;
		};
	};
}

async function loadTwitterWidgets(): Promise<NonNullable<TwitterWindow["twttr"]>>
{
	const existing = (window as TwitterWindow).twttr;
	if (existing !== undefined)
	{
		return Promise.resolve(existing);
	}
	return new Promise((resolve, reject) =>
	{
		const script = document.createElement("script");
		script.src = "https://platform.twitter.com/widgets.js";
		script.async = true;
		script.addEventListener("load", () =>
		{
			const loaded = (window as TwitterWindow).twttr;
			if (loaded === undefined)
			{
				reject(new Error("twitter widgets did not load"));
			}
			else
			{
				resolve(loaded);
			}
		});
		script.addEventListener("error", () =>
		{
			reject(new Error("twitter widgets failed to load"));
		});
		document.head.append(script);
	});
}

function TweetEmbed({tweetId}: {tweetId: string})
{
	const hostRef = useRef<HTMLDivElement>(null);
	useEffect(() =>
	{
		const host = hostRef.current;
		if (host === null)
		{
			return;
		}
		loadTwitterWidgets()
			.then(async (twttr) => twttr.widgets.createTweet(tweetId, host))
			.catch(() => {});
	}, [tweetId]);
	return <div className="twitter-tweet" ref={hostRef} />;
}

/** Upstream's `div.ml-xl` after a row's name, holding the embed: a 16/9 (or 9/16) iframe frame, or a tweet. */
export function EmbedView({embed}: {embed: Embed}): ReactNode
{
	let content: ReactNode;
	if (embed.kind === "twitter")
	{
		content = (
			<div className="w-full">
				<TweetEmbed tweetId={embed.tweetId} />
			</div>
		);
	}
	else if (embed.kind === "yt_short")
	{
		content = (
			<div className="w-full">
				<div
					className={FRAME_CLASS}
					style={
					{
						aspectRatio: embed.aspectRatio,
					}}
				>
					<iframe
						sandbox={EMBED_SANDBOX}
						src={embed.src}
						title="YouTube Short"
						allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
						referrerPolicy="origin"
						allowFullScreen
					/>
				</div>
			</div>
		);
	}
	else if (embed.kind === "loom")
	{
		content = (
			<div className="w-full">
				<div className={FRAME_CLASS}>
					<iframe sandbox={EMBED_SANDBOX} src={embed.src} title="Loom video" allowFullScreen />
				</div>
			</div>
		);
	}
	else
	{
		content = (
			<div className="w-full">
				<div className={FRAME_CLASS}>
					<iframe
						sandbox={EMBED_SANDBOX}
						width={560}
						height={315}
						src={embed.src}
						title="YouTube video"
						referrerPolicy="strict-origin-when-cross-origin"
						allowFullScreen
					/>
				</div>
			</div>
		);
	}
	return <div className="ml-xl">{content}</div>;
}
