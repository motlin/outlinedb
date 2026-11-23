import {describe, expect, it} from "vite-plus/test";
import {cookieHeader, mergeSetCookies, parseLoginForm} from "../src/api/workflowy-login-form.js";

const EMAIL_STEP = `<!doctype html><html><head><script>if ($("#code").length) { focus(); }</script></head><body>
<form class="search" method="GET"><input type="text" name="q"></form>
<form method="POST" action="">
	<input type="hidden" name="next" value="/home?x=1&amp;y=2">
	<input type="hidden" name="utm_source" value="">
	<input type='hidden' name='utm_campaign' value=''>
	<input type="hidden" name="utm_medium">
	<label for="id_email">Email</label>
	<input type="email" name="email" id="id_email" value="alice@example.com" required>
	<div id="password"><label for="id_password">Password</label><input type="password" name="password" id="id_password"></div>
	<ul class="errorlist nonfield"><li>Wrong password. <b>Try again</b>&#33;</li></ul>
	<ul class="errorlist"><li>That&#39;s not right</li></ul>
	<label><input type="checkbox" name="remember" checked> Remember me</label>
	<input type="checkbox" name="newsletter" value="yes">
	<input type="radio" name="method" value="app" checked><input type="radio" name="method" value="sms">
	<button type="button" name="toggle" value="t">Show</button>
	<button name="login_step" value="password">Go</button>
	<button type="submit" name="other" value="x">Other</button>
	<input type="submit" name="also" value="Log in">
</form></body></html>`;

describe("workflowy.com's login form", () =>
{
	it("reads the POST form's hidden values, the fields it asks for with their labels, and its errors", () =>
	{
		expect(
			{
				full: parseLoginForm(EMAIL_STEP),
				code: parseLoginForm(
					'<form method="post"><input type=hidden name=email value="a@b.c"><input name="code" autocomplete="one-time-code" inputmode="numeric"></form>',
				),
				captcha: parseLoginForm(
					'<form method="POST"><input name="email"><div class="g-recaptcha" data-sitekey="k"></div><ul class="errorlist"><li>Just making sure you&#x27;re human...</li></ul></form>',
				),
				noForm: parseLoginForm("<html><body>Welcome back</body></html>"),
			},
		).toStrictEqual(
			{
				full:
				{
					hidden:
					{
						next: "/home?x=1&y=2",
						utm_source: "",
						utm_campaign: "",
						utm_medium: "",
						// A checked box or radio goes as a browser sends it, and so does the default (first) submit button, as Enter sends it.
						remember: "on",
						method: "app",
						login_step: "password",
					},
					fields: [
						{
							name: "password",
							type: "password",
							label: "Password",
						},
					],
					errors: ["Wrong password. Try again!", "That's not right"],
					captcha: false,
				},
				// A hidden email is still the email, never a field to ask for; an unlabelled input falls back to its name.
				code:
				{
					hidden: {},
					fields: [
						{
							name: "code",
							type: "text",
							label: "code",
						},
					],
					errors: [],
					captcha: false,
				},
				captcha:
				{
					hidden: {},
					fields: [],
					errors: ["Just making sure you're human..."],
					captcha: true,
				},
				noForm: undefined,
			},
		);
	});

	it("keeps a cookie jar from Set-Cookie headers, dropping cookies the server expires", () =>
	{
		const headers = new Headers();
		headers.append("set-cookie", "_bess=abc; Path=/; HttpOnly");
		headers.append("set-cookie", "csrftoken=t1; Max-Age=31449600; Path=/");
		headers.append("set-cookie", "old=1; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/");
		headers.append("set-cookie", "gone=; Max-Age=0; Path=/");
		const jar = mergeSetCookies(
			{
				old: "0",
				gone: "x",
				kept: "y",
			},
			headers,
		);
		expect(
			{
				jar,
				header: cookieHeader(jar),
			},
		).toStrictEqual(
			{
				jar:
				{
					kept: "y",
					_bess: "abc",
					csrftoken: "t1",
				},
				header: "kept=y; _bess=abc; csrftoken=t1",
			},
		);
	});
});
