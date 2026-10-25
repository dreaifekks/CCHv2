// Codeforces puts its login page behind Cloudflare Turnstile, and Turnstile
// never passes inside NW.js (it fails the same way on every NW.js version,
// while Google Chrome on the same machine passes). So log in with a real
// Chrome-family browser instead: launch it with a profile dedicated to CCHv2
// and a local DevTools port, let the user log in there, then copy the
// codeforces.com session cookies into the app and close that browser.
var chromeLogin = (function() {
	var fs, path, os, childProcess, net;
	try {
		fs = require("fs");
		path = require("path");
		os = require("os");
		childProcess = require("child_process");
		net = require("net");
	} catch (e) {
		return {
			available: function() {
				return false;
			}
		};
	}

	var CANDIDATES = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		"/Applications/Chromium.app/Contents/MacOS/Chromium"
	];
	// cookies bound to the browser fingerprint; copying them would only hurt
	var SKIP = /^(cf_clearance|__cf_bm|cf_chl_.*|_cfuvid)$/;
	var POLL_MS = 2000,
		TIMEOUT_MS = 15 * 60 * 1000;

	function findBrowser() {
		for (var i = 0; i < CANDIDATES.length; i++)
			if (fs.existsSync(CANDIDATES[i])) return CANDIDATES[i];
		return null;
	}

	function freePort() {
		return new Promise(function(resolve, reject) {
			var s = net.createServer();
			s.once("error", reject);
			s.listen(0, "127.0.0.1", function() {
				var p = s.address().port;
				s.close(function() {
					resolve(p);
				});
			});
		});
	}

	function cdpCall(wsUrl, method, params) {
		return new Promise(function(resolve, reject) {
			var ws = new WebSocket(wsUrl);
			var timer = setTimeout(function() {
				ws.close();
				reject(new Error("cdp timeout"));
			}, 10000);
			ws.onopen = function() {
				ws.send(JSON.stringify({
					id: 1,
					method: method,
					params: params || {}
				}));
			};
			ws.onmessage = function(e) {
				var m = JSON.parse(e.data);
				if (m.id != 1) return;
				clearTimeout(timer);
				ws.close();
				if (m.error) reject(new Error(m.error.message));
				else resolve(m.result);
			};
			ws.onerror = function() {
				clearTimeout(timer);
				reject(new Error("cdp connection failed"));
			};
		});
	}

	function getJSON(url) {
		return fetch(url).then(function(r) {
			return r.json();
		});
	}

	// Is the Codeforces page in the browser showing a logged-in header?
	function pageLoggedIn(port) {
		return getJSON("http://127.0.0.1:" + port + "/json/list").then(function(list) {
			var pages = list.filter(function(t) {
				return t.type == "page" && /^https:\/\/([a-z]+\.)?codeforces\.com\//.test(t.url) && t.url.indexOf("/enter") == -1;
			});
			return pages.reduce(function(acc, t) {
				return acc.then(function(found) {
					if (found) return true;
					return cdpCall(t.webSocketDebuggerUrl, "Runtime.evaluate", {
						expression: "[...document.querySelectorAll('.lang-chooser a')].some(function(a){return /\\/logout/.test(a.getAttribute('href')||'')})",
						returnByValue: true
					}).then(function(r) {
						return r.result && r.result.value === true;
					}, function() {
						return false;
					});
				});
			}, Promise.resolve(false));
		});
	}

	// On a fresh profile Codeforces first lands on its home page; send the
	// browser back to the login page once.
	function reopenLoginPage(port, loginUrl) {
		return getJSON("http://127.0.0.1:" + port + "/json/list").then(function(list) {
			var onEnter = list.some(function(t) {
				return t.type == "page" && t.url.indexOf("/enter") != -1;
			});
			var home = list.find(function(t) {
				return t.type == "page" && /^https:\/\/codeforces\.com\/(\?.*)?$/.test(t.url);
			});
			if (onEnter || !home) return false;
			return cdpCall(home.webSocketDebuggerUrl, "Page.navigate", {
				url: loginUrl
			}).then(function() {
				return true;
			});
		}).catch(function() {
			return false;
		});
	}

	// Fill the login form with the handle/password saved in CCHv2 settings and
	// submit it. Resolves "submitted", or another state when it should be
	// retried later ("noform", "waiting" for the form's own Turnstile token).
	function fillLogin(port, creds) {
		return getJSON("http://127.0.0.1:" + port + "/json/list").then(function(list) {
			var page = list.find(function(t) {
				return t.type == "page" && /^https:\/\/codeforces\.com\/enter/.test(t.url);
			});
			if (!page) return "noform";
			var script = "(function(c){" +
				"var h=document.querySelector('input[name=handleOrEmail]');if(!h)return 'noform';" +
				"var f=h.form,p=f.querySelector('input[name=password]');" +
				"var ts=f.querySelector('[name=cf-turnstile-response]');if(ts&&!ts.value)return 'waiting';" +
				"function set(el,v){el.focus();el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}" +
				"set(h,c.u);set(p,c.p);" +
				"var r=f.querySelector('input[name=remember]');if(r&&!r.checked)r.click();" +
				"var b=f.querySelector('input[type=submit],button[type=submit]');if(b)b.click();else f.submit();" +
				"return 'submitted';})(" + JSON.stringify({
					u: creds.handle,
					p: creds.password
				}) + ")";
			return cdpCall(page.webSocketDebuggerUrl, "Runtime.evaluate", {
				expression: script,
				returnByValue: true
			}).then(function(r) {
				return r.result && r.result.value;
			});
		}).catch(function() {
			return "noform";
		});
	}

	function copyCookies(port) {
		return getJSON("http://127.0.0.1:" + port + "/json/version").then(function(v) {
			return cdpCall(v.webSocketDebuggerUrl, "Storage.getCookies", {});
		}).then(function(r) {
			var cookies = r.cookies.filter(function(c) {
				return /(^|\.)codeforces\.com$/.test(c.domain) && !SKIP.test(c.name);
			});
			var jar = nw.Window.get().cookies;
			return Promise.all(cookies.map(function(c) {
				var host = c.domain.replace(/^\./, "");
				var d = {
					url: "https://" + host + c.path,
					name: c.name,
					value: c.value,
					path: c.path,
					secure: c.secure,
					httpOnly: c.httpOnly
				};
				if (c.domain.charAt(0) == ".") d.domain = c.domain;
				if (c.sameSite) d.sameSite = {
					Strict: "strict",
					Lax: "lax",
					None: "no_restriction"
				}[c.sameSite] || "unspecified";
				if (!c.session && c.expires > 0) d.expirationDate = c.expires;
				return new Promise(function(resolve) {
					jar.set(d, function() {
						resolve();
					});
				});
			})).then(function() {
				return cookies.length;
			});
		});
	}

	function closeBrowser(port) {
		return getJSON("http://127.0.0.1:" + port + "/json/version").then(function(v) {
			return cdpCall(v.webSocketDebuggerUrl, "Browser.close", {});
		}).catch(function() {});
	}

	// done(err) is called once: err == null when cookies were copied.
	// creds ({handle, password}) are optional; without them the user types
	// them in the browser window.
	function start(loginUrl, creds, done) {
		var bin = findBrowser();
		if (!bin) return done(new Error("no Chrome-family browser found"));
		var profile = path.join(path.dirname(nw.App.dataPath), "chrome-login-profile");
		var finished = false;

		function finish(err) {
			if (finished) return;
			finished = true;
			done(err);
		}
		freePort().then(function(port) {
			var child = childProcess.spawn(bin, [
				"--user-data-dir=" + profile,
				"--remote-debugging-port=" + port,
				// DevTools rejects WebSocket clients from other origins; allow only this app
				"--remote-allow-origins=" + location.origin,
				"--no-first-run",
				"--no-default-browser-check",
				"--new-window",
				loginUrl
			], {
				detached: true,
				stdio: "ignore"
			});
			child.on("error", function(e) {
				finish(e);
			});
			child.unref();
			var started = Date.now(),
				reachable = false,
				reopened = false,
				// submit saved credentials at most once, so a wrong password
				// cannot turn into repeated login attempts
				filled = !(creds && creds.handle && creds.password),
				filling = false;

			function poll() {
				if (finished) return;
				if (Date.now() - started > TIMEOUT_MS) {
					closeBrowser(port);
					return finish(new Error("timeout"));
				}
				pageLoggedIn(port).then(function(ok) {
					reachable = true;
					if (!ok) {
						if (!reopened) reopenLoginPage(port, loginUrl).then(function(done) {
							reopened = done;
						});
						if (!filled && !filling) {
							filling = true;
							fillLogin(port, creds).then(function(state) {
								filling = false;
								if (state == "submitted") filled = true;
							});
						}
						return setTimeout(poll, POLL_MS);
					}
					return copyCookies(port).then(function() {
						closeBrowser(port);
						finish(null);
					});
				}, function() {
					// DevTools gone after it was up: the user closed the browser
					if (reachable) return finish(new Error("browser closed"));
					if (Date.now() - started > 30000) return finish(new Error("browser did not start"));
					setTimeout(poll, POLL_MS);
				});
			}
			setTimeout(poll, POLL_MS);
		}, finish);
	}

	return {
		available: function() {
			return findBrowser() != null;
		},
		start: start,
		copyCookies: copyCookies
	};
})();
