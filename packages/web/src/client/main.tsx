import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {App} from "./app.js";
import {IS_MOBILE, applyDeviceClass} from "./is-mobile.js";
import {clearPrepaintBackground} from "./theme-apply.js";
import {applyEmoji, storedEmoji} from "./emoji-apply.js";
import "./print.css";
import {installPrintListeners} from "./hooks/use-printing.js";

const rootElement = document.querySelector("#root");
if (!rootElement) {
	throw new Error("Root element not found");
}

// Upstream decides once at boot and never recomputes on resize.
applyDeviceClass(document.body, IS_MOBILE, navigator.userAgent);

installPrintListeners(window);

// Upstream applies this browser's saved emoji style at boot, before the account's arrives.
applyEmoji(storedEmoji());

const root = createRoot(rootElement);
root.render(
	<StrictMode>
		<App />
	</StrictMode>,
);

// Upstream clears the inline pre-paint background once the app is ready.
requestAnimationFrame(() => {
	requestAnimationFrame(clearPrepaintBackground);
});
