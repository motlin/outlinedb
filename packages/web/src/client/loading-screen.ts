async function nextFrame(): Promise<void>
{
	return new Promise((resolve) =>
	{
		setTimeout(resolve, 0);
	});
}

async function wait(ms: number): Promise<void>
{
	return new Promise((resolve) =>
	{
		setTimeout(resolve, ms);
	});
}

/** Upstream `hideLoadingScreen` (`kr1`): fade `#loadingScreen` out, remove it, and drop the pre-paint body background. */
export async function hideLoadingScreen(doc: Document = document, ms = 150): Promise<void>
{
	const screen = doc.querySelector<HTMLElement>("#loadingScreen");
	if (screen === null)
	{
		return;
	}
	screen.style.opacity = "1";
	await nextFrame();
	screen.style.transition = `opacity ${ms}ms`;
	screen.style.opacity = "0";
	await wait(ms + 100);
	screen.style.display = "none";
	screen.style.opacity = "";
	screen.style.transition = "";
	doc.body.style.background = "";
}

let hidden = false;

/** Hides the boot screen once; later calls (cold zooms) leave it alone. */
export function hideLoadingScreenOnce(): void
{
	if (hidden)
	{
		return;
	}
	hidden = true;
	void hideLoadingScreen();
}
