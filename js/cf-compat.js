// Compatibility layer for Codeforces API changes (2025-2026).
//
// contest.standings for non-gym contests now only answers anonymous GET
// requests with no parameter other than contestId. Every other form (handles,
// showUnofficial, from/count, apiKey signature) fails with
// "Non-gym contest standings for non-admin users are available only via
// anonymous GET requests with no extra parameters".
//
// This file adds a jQuery transport that serves the old request shapes:
// it downloads the anonymous standings once, filters rows locally, and, when
// unofficial rows for given handles are requested (virtual / out of
// competition), rebuilds them from contest.status submissions.

(function(root) {
	var CACHE_TTL = 3000;
	var MAX_UNOFFICIAL_HANDLES = 10;
	var standingsCache = {};

	function parseQuery(url) {
		var ret = {};
		var q = url.indexOf("?");
		if (q == -1) return ret;
		url.substr(q + 1).split("#")[0].split("&").forEach(function(kv) {
			if (kv == "") return;
			var p = kv.indexOf("=");
			var k = p == -1 ? kv : kv.substr(0, p);
			var v = p == -1 ? "" : kv.substr(p + 1);
			try {
				ret[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
			} catch (e) {
				ret[k] = v;
			}
		});
		return ret;
	}

	function apiBase(url) {
		return url.split("?")[0].replace(/\/contest\.standings$/, "");
	}

	function getJSON(url, signal) {
		return fetch(url, {
			credentials: "omit",
			signal: signal
		}).then(function(r) {
			return r.text().then(function(t) {
				var j;
				try {
					j = JSON.parse(t);
				} catch (e) {
					j = null;
				}
				return {
					status: r.status,
					json: j,
					text: t
				};
			});
		});
	}

	function getAnonymousStandings(base, contestId, signal) {
		var key = base + "#" + contestId;
		var c = standingsCache[key];
		var now = Date.now();
		if (c && now - c.time < CACHE_TTL) return c.promise;
		var p = getJSON(base + "/contest.standings?contestId=" + contestId, signal);
		standingsCache[key] = {
			time: now,
			promise: p
		};
		p.catch(function() {
			if (standingsCache[key] && standingsCache[key].promise === p) delete standingsCache[key];
		});
		return p;
	}

	function handleSet(str) {
		var s = {};
		String(str).split(/[;,]/).forEach(function(h) {
			h = h.trim().toLowerCase();
			if (h != "") s[h] = true;
		});
		return s;
	}

	function rowHasHandle(row, hs) {
		var m = row.party.members || [];
		for (var i = 0; i < m.length; i++)
			if (hs[String(m[i].handle).toLowerCase()]) return true;
		return false;
	}

	// Decay constant k of CF-type scoring: lost points = floor(x * minutes / k).
	// It differs between contests (250 for most rounds, 375 for a 3-hour one),
	// so it is inferred from the official rows.
	function inferDecay(result) {
		var ks = [];
		var probs = result.problems;
		for (var r = 0; r < result.rows.length && r < 300; r++) {
			var pr = result.rows[r].problemResults;
			for (var i = 0; i < pr.length; i++) {
				var x = probs[i] && probs[i].points;
				if (!x || !(pr[i].points > 0) || pr[i].bestSubmissionTimeSeconds == undefined) continue;
				var t = Math.floor(pr[i].bestSubmissionTimeSeconds / 60);
				var loss = x - pr[i].points - 50 * pr[i].rejectedAttemptCount;
				if (t > 0 && loss > 0 && pr[i].points > 0.3 * x + 1) ks.push(x * t / loss);
			}
		}
		if (ks.length == 0) return 250;
		ks.sort(function(a, b) {
			return a - b;
		});
		return Math.round(ks[Math.floor(ks.length / 2)] * 4) / 4;
	}

	// Penalty minutes per rejected attempt in ICPC-type contests, inferred the same way.
	function inferIcpcPenalty(result) {
		for (var r = 0; r < result.rows.length && r < 300; r++) {
			var row = result.rows[r];
			var rej = 0,
				minutes = 0;
			row.problemResults.forEach(function(p) {
				if (p.points > 0 && p.bestSubmissionTimeSeconds != undefined) {
					rej += p.rejectedAttemptCount;
					minutes += Math.floor(p.bestSubmissionTimeSeconds / 60);
				}
			});
			if (rej > 0) return Math.round((row.penalty - minutes) / rej);
		}
		return 10;
	}

	function isRejected(s) {
		if (s.verdict == undefined || s.verdict == "TESTING" || s.verdict == "OK") return false;
		if (s.verdict == "COMPILATION_ERROR") return false;
		// failing the first test is not penalized
		if (s.passedTestCount == 0 && s.verdict != "CHALLENGED") return false;
		return true;
	}

	// Build standings rows for the participants found in `subs` (contest.status
	// submissions). Only participant types listed in `types` are built.
	function synthesizeRows(result, subs, types) {
		var contest = result.contest,
			probs = result.problems;
		var parties = {};
		subs.forEach(function(s) {
			var a = s.author;
			if (types.indexOf(a.participantType) == -1) return;
			var key = a.participantId != undefined ? a.participantId : a.participantType + "@" + a.startTimeSeconds;
			if (!parties[key]) parties[key] = {
				party: a,
				subs: []
			};
			parties[key].subs.push(s);
		});
		var decay = contest.type == "CF" ? inferDecay(result) : 0;
		var icpcPen = contest.type == "ICPC" ? inferIcpcPenalty(result) : 0;
		var rows = [];
		Object.keys(parties).forEach(function(key) {
			var P = parties[key];
			P.subs.sort(function(a, b) {
				return a.relativeTimeSeconds - b.relativeTimeSeconds || a.id - b.id;
			});
			var total = 0,
				penalty = 0;
			var problemResults = probs.map(function(prob) {
				var rej = 0,
					best = undefined,
					pts = 0,
					prelim = false;
				for (var i = 0; i < P.subs.length; i++) {
					var s = P.subs[i];
					if (s.problem.index != prob.index) continue;
					if (s.verdict == undefined || s.verdict == "TESTING") {
						prelim = true;
						continue;
					}
					if (contest.type == "IOI") {
						if (s.points != undefined && s.points > pts) pts = s.points, best = s.relativeTimeSeconds;
						continue;
					}
					if (s.verdict == "OK") {
						best = s.relativeTimeSeconds;
						break;
					}
					// a skipped submission is a penalized attempt only when it was
					// replaced by a later resubmission (not when disqualified)
					if (s.verdict == "SKIPPED" && !P.subs.slice(i + 1).some(function(t) {
							return t.problem.index == prob.index;
						})) continue;
					if (isRejected(s)) rej++;
				}
				if (contest.type != "IOI" && best != undefined) {
					var minutes = Math.floor(best / 60);
					if (contest.type == "CF" && prob.points) {
						pts = Math.max(0.3 * prob.points, prob.points - Math.floor(prob.points * minutes / decay) - 50 * rej);
					} else {
						pts = 1;
						penalty += minutes + icpcPen * rej;
					}
				}
				total += pts;
				var ret = {
					points: pts,
					rejectedAttemptCount: rej,
					type: prelim || contest.phase != "FINISHED" ? "PRELIMINARY" : "FINAL"
				};
				if (best != undefined) ret.bestSubmissionTimeSeconds = best;
				return ret;
			});
			var rank = 1;
			result.rows.forEach(function(r) {
				if (r.points > total || (r.points == total && r.penalty < penalty)) rank++;
			});
			rows.push({
				party: P.party,
				rank: rank,
				points: total,
				penalty: penalty,
				successfulHackCount: 0,
				unsuccessfulHackCount: 0,
				problemResults: problemResults
			});
		});
		return rows;
	}

	function serveStandings(url, signal) {
		var q = parseQuery(url);
		var base = apiBase(url);
		var cid = q.contestId;
		return getAnonymousStandings(base, cid, signal).then(function(res) {
			if (!res.json || res.json.status != "OK") return res;
			var src = res.json.result;
			var result = {
				contest: src.contest,
				problems: src.problems,
				rows: src.rows
			};
			var showUnofficial = q.showUnofficial == "true";
			var hs = q.handles ? handleSet(q.handles) : null;
			if (hs) result.rows = result.rows.filter(function(r) {
				return rowHasHandle(r, hs);
			});
			if (q.room) result.rows = result.rows.filter(function(r) {
				return String(r.party.room) == q.room;
			});
			var extra = Promise.resolve([]);
			if (hs && showUnofficial) {
				var types = ["VIRTUAL", "OUT_OF_COMPETITION"];
				// one contest.status call per handle; capped to stay within the API call limit
				extra = Promise.all(Object.keys(hs).slice(0, MAX_UNOFFICIAL_HANDLES).map(function(h) {
					return getJSON(base + "/contest.status?contestId=" + cid + "&handle=" + encodeURIComponent(h), signal).then(function(r) {
						return r.json && r.json.status == "OK" ? r.json.result : [];
					}, function() {
						return [];
					});
				})).then(function(lists) {
					var subs = [].concat.apply([], lists);
					return synthesizeRows(src, subs, types);
				});
			}
			return extra.then(function(rows) {
				result.rows = result.rows.concat(rows);
				result.rows.sort(function(a, b) {
					return a.rank - b.rank;
				});
				var from = Number(q.from || 1),
					count = q.count != undefined ? Number(q.count) : Infinity;
				if (from > 1 || count != Infinity) result.rows = result.rows.slice(from - 1, from - 1 + count);
				var j = {
					status: "OK",
					result: result
				};
				return {
					status: 200,
					json: j,
					text: JSON.stringify(j)
				};
			});
		});
	}

	function needsCompat(url) {
		if (!/\/api\/contest\.standings\?/.test(url)) return false;
		var q = parseQuery(url);
		if (!/^\d+$/.test(q.contestId || "") || Number(q.contestId) >= 100000) return false;
		return Object.keys(q).some(function(k) {
			return k != "contestId";
		});
	}

	root.cfCompat = {
		parseQuery: parseQuery,
		synthesizeRows: synthesizeRows,
		inferDecay: inferDecay,
		inferIcpcPenalty: inferIcpcPenalty,
		serveStandings: serveStandings,
		needsCompat: needsCompat
	};

	if (root.jQuery) {
		root.jQuery.ajaxTransport("+*", function(options) {
			if (options.type && options.type.toUpperCase() != "GET") return;
			if (!needsCompat(options.url)) return;
			var ctrl = null;
			return {
				send: function(headers, complete) {
					ctrl = new AbortController();
					var timer = options.timeout > 0 ? setTimeout(function() {
						ctrl.abort();
					}, options.timeout) : null;
					serveStandings(options.url, ctrl.signal).then(function(res) {
						if (timer) clearTimeout(timer);
						complete(res.status, res.status == 200 ? "success" : "error", {
							json: res.json,
							text: res.text
						}, "Content-Type: application/json");
					}, function(e) {
						if (timer) clearTimeout(timer);
						if (ctrl.signal.aborted && options.timeout > 0) complete(0, "timeout");
						else complete(0, "error");
					});
				},
				abort: function() {
					if (ctrl) ctrl.abort();
				}
			};
		});
	}
})(typeof window != "undefined" ? window : globalThis);
