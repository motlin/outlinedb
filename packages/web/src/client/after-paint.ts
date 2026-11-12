/**
 * Resolves once the browser has painted the current frame: the next animation frame callback runs before that
 * frame's style, layout and paint, and a task queued from it runs after them. Work deferred this way (focusing the
 * edited row after a zoom) finds style and layout clean instead of forcing them inside the frame's task.
 */
export async function afterNextPaint(): Promise<void>
{
	return new Promise((resolve) =>
	{
		requestAnimationFrame(() =>
		{
			setTimeout(resolve, 0);
		});
	});
}
