// macOS window chrome: style hook for the title bar, and an empty native
// title. A frameless NW.js window on macOS still draws its native title
// text over the page, which showed up as a second line above our own.
(function() {
	if (typeof process == "undefined" || process.platform != "darwin") return;
	document.documentElement.classList.add("macos");

	// NW.js copies document.title into the native title, so clear both.
	function clearNativeTitle() {
		document.title = " ";
		try {
			nw.Window.get().title = " ";
		} catch (e) {}
	}
	window.addEventListener("load", function() {
		clearNativeTitle();
		setTimeout(clearNativeTitle, 500);
		setTimeout(clearNativeTitle, 1500);
	});
})();
