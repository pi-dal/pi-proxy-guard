/**
 * Proxy Guard — auto-recover Pi when the upstream proxy breaks.
 *
 * Trigger: `agent_before_settle` with outcome "error" = all provider retries
 * exhausted and Pi is about to pause. After "Retry failed after N attempts"
 * the errored assistant message is the last context message, so boundary
 * canContinue is FALSE and a bare {continue:true} is rejected; we append a
 * custom_message draft (projects to a `user` message for the LLM) with it.
 *
 * Flow on settle-error:
 *  1. Wait for any in-flight watchdog repair to finish (they serialize).
 *  2. Budget: max MAX_REPAIRS auto-continues per WINDOW_MS (rolling); a clean
 *     settle resets it. Exhausted -> stay paused, take over manually.
 *  3. curl CHECK_URL (inherits env proxy vars = same network path as Pi).
 *  4. Repair decision:
 *       - check down                      -> repair, then continue iff OK
 *       - check OK but ESCALATE_AFTER consecutive error settles
 *         (half-dead node: ping fine, streams cut) -> repair anyway
 *       - check OK                        -> backoff -> continue
 *  5. Repair chain (first success wins, each followed by a recheck):
 *       a. macOS Shortcuts shortcut (default "Reconnect Shadowrocket")
 *       b. scheme bounce: shadowrocket://stop -> shadowrocket://start
 *     If still down -> pausedByUs; watchdog auto-resumes once verified OK.
 *     Active repairs are capped at PAUSED_REPAIR_MAX per down-episode;
 *     afterwards the watchdog keeps a cheap passive watch and still
 *     auto-resumes when the proxy comes back on its own.
 *
 * Watchdog (WATCHDOG_MS): repairs the proxy while a run is mid-retry or while
 * paused-by-us (never while cleanly idle, so manually turning VPN off is
 * respected). On recovery + pausedByUs it sends sendUserMessage("continue").
 *
 * Env knobs (defaults):
 *   PI_PROXY_GUARD=0                     disable
 *   PI_PROXY_GUARD_URL                   https://www.google.com/generate_204
 *   PI_PROXY_GUARD_PROXY                 (unset = inherit env proxy vars)
 *   PI_PROXY_GUARD_TIMEOUT_MS            10000
 *   PI_PROXY_GUARD_SHORTCUT              "Reconnect Shadowrocket" ("" disables)
 *   PI_PROXY_GUARD_SHORTCUT_TIMEOUT_MS   120000
 *   PI_PROXY_GUARD_SCHEME                "1" (shadowrocket:// fallback)
 *   PI_PROXY_GUARD_SCHEME_STOP           shadowrocket://stop
 *   PI_PROXY_GUARD_SCHEME_START          shadowrocket://start
 *   PI_PROXY_GUARD_ESCALATE_AFTER        2   (consecutive errors w/ OK check)
 *   PI_PROXY_GUARD_PAUSED_REPAIRS        3   (active repair cap while paused)
 *   PI_PROXY_GUARD_REPAIR_COOLDOWN_MS    90000
 *   PI_PROXY_GUARD_RECHECK_DELAY_MS      8000
 *   PI_PROXY_GUARD_BACKOFF_MS            3000
 *   PI_PROXY_GUARD_MAX_REPAIRS           5
 *   PI_PROXY_GUARD_WINDOW_MS             600000
 *   PI_PROXY_GUARD_WATCHDOG_MS           60000  (0 disables)
 *   PI_PROXY_GUARD_NOTIFY                "macos,bark,webhook"
 *                                          (channels, "0"/off disables all)
 *   PI_PROXY_GUARD_NOTIFY_RESUME         "0"    (1 also notifies on recovery)
 *   PI_PROXY_GUARD_NOTIFY_COOLDOWN_MS    600000
 *   PI_PROXY_GUARD_BARK                  ""    Bark push URL, e.g.
 *                                          https://api.day.app/<device_key>
 *   PI_PROXY_GUARD_WEBHOOK               ""    POSTs {title,body} JSON
 *   Push requests always go DIRECT (--noproxy '*'): the whole point is
 *   reaching you while the proxy is dead.
 *   PI_PROXY_GUARD_LOG                   ~/.pi/agent/proxy-guard.log ("" disables)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DISABLED = process.env.PI_PROXY_GUARD === "0";
const CHECK_URL = process.env.PI_PROXY_GUARD_URL ?? "https://www.google.com/generate_204";
const CHECK_PROXY = process.env.PI_PROXY_GUARD_PROXY;
const CHECK_TIMEOUT_MS = Number(process.env.PI_PROXY_GUARD_TIMEOUT_MS ?? 10_000);
const SHORTCUT = process.env.PI_PROXY_GUARD_SHORTCUT ?? "Reconnect Shadowrocket";
const SHORTCUT_TIMEOUT_MS = Number(process.env.PI_PROXY_GUARD_SHORTCUT_TIMEOUT_MS ?? 120_000);
const USE_SCHEME = process.env.PI_PROXY_GUARD_SCHEME !== "0";
const SCHEME_STOP = process.env.PI_PROXY_GUARD_SCHEME_STOP ?? "shadowrocket://stop";
const SCHEME_START = process.env.PI_PROXY_GUARD_SCHEME_START ?? "shadowrocket://start";
const ESCALATE_AFTER = Number(process.env.PI_PROXY_GUARD_ESCALATE_AFTER ?? 2);
const PAUSED_REPAIR_MAX = Number(process.env.PI_PROXY_GUARD_PAUSED_REPAIRS ?? 3);
const REPAIR_COOLDOWN_MS = Number(process.env.PI_PROXY_GUARD_REPAIR_COOLDOWN_MS ?? 90_000);
const RECHECK_DELAY_MS = Number(process.env.PI_PROXY_GUARD_RECHECK_DELAY_MS ?? 8_000);
const BACKOFF_MS = Number(process.env.PI_PROXY_GUARD_BACKOFF_MS ?? 3_000);
const MAX_REPAIRS = Number(process.env.PI_PROXY_GUARD_MAX_REPAIRS ?? 5);
const WINDOW_MS = Number(process.env.PI_PROXY_GUARD_WINDOW_MS ?? 600_000);
const WATCHDOG_MS = Number(process.env.PI_PROXY_GUARD_WATCHDOG_MS ?? 60_000);
const NOTIFY_CHANNELS = process.env.PI_PROXY_GUARD_NOTIFY === "0" || process.env.PI_PROXY_GUARD_NOTIFY === "off"
	? []
	: (process.env.PI_PROXY_GUARD_NOTIFY ?? "macos,bark,webhook").split(",").map((s) => s.trim()).filter(Boolean);
const NOTIFY_RESUME = process.env.PI_PROXY_GUARD_NOTIFY_RESUME === "1";
const NOTIFY_COOLDOWN_MS = Number(process.env.PI_PROXY_GUARD_NOTIFY_COOLDOWN_MS ?? 600_000);
const BARK = process.env.PI_PROXY_GUARD_BARK ?? "";
const WEBHOOK = process.env.PI_PROXY_GUARD_WEBHOOK ?? "";
const PUSH_TITLE = "pi proxy-guard";
const LOG_FILE =
	process.env.PI_PROXY_GUARD_LOG !== ""
		? (process.env.PI_PROXY_GUARD_LOG ?? join(homedir(), ".pi", "agent", "proxy-guard.log"))
		: "";

const NUDGE_CUSTOM_TYPE = "proxy-guard-recovery";
const NUDGE_TEXT =
	"[proxy-guard] The previous model request failed with a network error (stream cut, retries exhausted). " +
	"Connectivity has been verified again. Continue exactly where you left off.";
const RESUME_TEXT = "continue";

function log(message: string): void {
	if (!LOG_FILE) return;
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
		appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
	} catch {
		/* never let logging break the guard */
	}
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	log(`[${level}] ${message}`);
	if (ctx.hasUI) ctx.ui.notify(`[proxy-guard] ${message}`, level);
	else console.error(`[proxy-guard] ${message}`);
}

interface CheckResult {
	ok: boolean;
	status?: number;
	error?: string;
}

function checkProxy(): Promise<CheckResult> {
	return new Promise((resolve) => {
		const args = ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", String(Math.ceil(CHECK_TIMEOUT_MS / 1000))];
		if (CHECK_PROXY) args.push("-x", CHECK_PROXY);
		args.push(CHECK_URL);
		execFile("curl", args, { timeout: CHECK_TIMEOUT_MS + 2_000 }, (err, stdout) => {
			const status = Number.parseInt((stdout ?? "").trim(), 10);
			if (!err && status >= 200 && status < 400) resolve({ ok: true, status });
			else resolve({ ok: false, status: Number.isFinite(status) ? status : undefined, error: (err?.message ?? "").split("\n")[0] });
		});
	});
}

function execCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
			resolve(err ? { ok: false, error: ((stderr || "") + err.message).split("\n")[0].trim() } : { ok: true });
		});
	});
}

export default function (pi: ExtensionAPI) {
	if (DISABLED) return;

	/** Timestamps of issued auto-continues, pruned against WINDOW_MS. */
	let repairs: number[] = [];
	/** Consecutive settle-errors without a clean run in between. */
	let consecutiveErrors = 0;
	/** Set when we stayed paused because the proxy was down; watchdog resumes us. */
	let pausedByUs = false;
	/** True while an agent run is live (agent_start .. agent_settled). */
	let runActive = false;
	/** Repairs attempted since the last successful probe (per down-episode). */
	let failedRepairs = 0;
	let gaveUpNotified = false;
	/** Re-entrancy + serialization. */
	let busy = false;
	let repairing = false;
	let ticking = false;
	let lastRepairAt = 0;
	let lastNotifyAt = 0;
	/** Session-scoped watchdog + captured context. */
	let watchdog: ReturnType<typeof setInterval> | undefined;
	let sessionCtx: ExtensionContext | undefined;

	const budgetLeft = (): number => {
		const cutoff = Date.now() - WINDOW_MS;
		repairs = repairs.filter((t) => t > cutoff);
		return MAX_REPAIRS - repairs.length;
	};
	const chargeBudget = (): void => {
		repairs.push(Date.now());
	};

	/** Serialize settle handler behind an in-flight watchdog repair. */
	async function waitForRepair(deadlineMs: number): Promise<void> {
		const deadline = Date.now() + deadlineMs;
		while (repairing && Date.now() < deadline) await sleep(500);
	}

	/** Push notifications (iPhone via Bark, generic webhook, macOS fallback).
	 *  Throttled: each fire doubles as a periodic "still broken" reminder.
	 *  Push requests bypass the proxy (--noproxy '*') — they must reach the
	 *  phone exactly when the proxy is dead. */
	function systemNotify(body: string): void {
		if (NOTIFY_CHANNELS.length === 0) return;
		if (Date.now() - lastNotifyAt < NOTIFY_COOLDOWN_MS) {
			log("notification throttled");
			return;
		}
		lastNotifyAt = Date.now();
		// Machine + cwd prefix, same format as @herbertgao/pi-bark, so pushes
		// from pi-sync'd machines are attributable at a glance.
		const full = `\ud83d\udcbb ${hostname()}\n\ud83d\udcc1 ${process.cwd()}\n${body}`;
		const direct = ["--noproxy", "*", "-sS", "-m", "10"];
		for (const ch of NOTIFY_CHANNELS) {
			if (ch === "macos") {
				const safe = full.replace(/["\\]/g, "'");
				void execCmd("osascript", ["-e", `display notification "${safe}" with title "${PUSH_TITLE}" sound name "Ping"`], 10_000).then((r) => {
					if (!r.ok) log(`macos notify failed: ${r.error}`);
				});
			} else if (ch === "bark" && BARK) {
				// POST form (same shape as Bark docs): robust for unicode/special chars.
				void execCmd("curl", [...direct, "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", BARK,
					"-d", `title=${PUSH_TITLE}`, "-d", `body=${full}`, "-d", "group=pi", "-d", "level=timeSensitive"], 15_000).then((r) => {
					log(`bark push ${r.ok ? "sent" : `failed: ${r.error}`}`);
				});
			} else if (ch === "webhook" && WEBHOOK) {
				const payload = JSON.stringify({ title: PUSH_TITLE, body: full }).replace(/'/g, "'\\''");
				void execCmd("curl", [...direct, "-X", "POST", "-H", "Content-Type: application/json", "-d", payload, "-o", "/dev/null", "-w", "%{http_code}", WEBHOOK], 15_000).then((r) => {
					log(`webhook push ${r.ok ? "sent" : `failed: ${r.error}`}`);
				});
			}
		}
	}

	/** checkProxy + episode bookkeeping: an OK probe resets the repair counter. */
	async function probe(): Promise<CheckResult> {
		const check = await checkProxy();
		if (check.ok) {
			failedRepairs = 0;
			gaveUpNotified = false;
		}
		return check;
	}

	/** True while we may still launch an active repair this down-episode. */
	const mayRepair = (): boolean => failedRepairs < PAUSED_REPAIR_MAX;

	/** Restart/switch the proxy. first success wins; each method rechecks. */
	async function repairProxy(ctx: ExtensionContext): Promise<boolean> {
		if (Date.now() - lastRepairAt < REPAIR_COOLDOWN_MS) {
			log("repair skipped: cooldown");
			return false;
		}
		repairing = true;
		lastRepairAt = Date.now();
		failedRepairs++;
		try {
			const recheck = async (): Promise<boolean> => {
				await sleep(RECHECK_DELAY_MS);
				const check = await checkProxy();
				if (!check.ok) log(`still down: ${check.error ?? `HTTP ${check.status}`}`);
				return check.ok;
			};
			const viaShortcut = async (): Promise<boolean> => {
				if (!SHORTCUT) return false;
				notify(ctx, `Running shortcut "${SHORTCUT}"…`, "warning");
				const res = await execCmd("shortcuts", ["run", SHORTCUT], SHORTCUT_TIMEOUT_MS);
				if (!res.ok) {
					log(`shortcut failed: ${res.error}`);
					return false;
				}
				return recheck();
			};
			const viaScheme = async (): Promise<boolean> => {
				if (!USE_SCHEME) return false;
				notify(ctx, "Bouncing Shadowrocket via URL scheme…", "warning");
				const stop = await execCmd("open", [SCHEME_STOP], 15_000);
				if (!stop.ok) {
					log(`scheme stop failed: ${stop.error}`);
					return false;
				}
				await sleep(3_000);
				const start = await execCmd("open", [SCHEME_START], 15_000);
				if (!start.ok) {
					log(`scheme start failed: ${start.error}`);
					return false;
				}
				return recheck();
			};

			for (const m of [viaShortcut, viaScheme]) {
				if (await m()) return true;
			}
			return false;
		} finally {
			repairing = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		pausedByUs = false;
		repairs = [];
		consecutiveErrors = 0;
		runActive = false;
		if (WATCHDOG_MS > 0 && !watchdog) {
			watchdog = setInterval(() => {
				void (async () => {
					if (ticking || busy || repairing || !sessionCtx) return;
					// Only spend effort when pi actually needs the connection:
					// a live run (internal retries benefit) or a paused-by-us session.
					if (!runActive && !pausedByUs) return;
					if (budgetLeft() <= 0) return;
					ticking = true;
					try {
						const check = await probe();
						if (check.ok) {
							// Recovered while paused: resume.
							if (pausedByUs && !runActive) {
								chargeBudget();
								pausedByUs = false;
								notify(sessionCtx, "Proxy verified OK — resuming paused session.");
								if (NOTIFY_RESUME) systemNotify("proxy recovered — session resumed");
								pi.sendUserMessage(RESUME_TEXT, { deliverAs: "followUp" });
							}
							return;
						}
						// Down: active repairs are capped at PAUSED_REPAIR_MAX per
						// down-episode; afterwards we keep a cheap passive watch and
						// still auto-resume when the proxy recovers on its own.
						if (!mayRepair()) {
							if (!gaveUpNotified) {
								gaveUpNotified = true;
								notify(sessionCtx, `Active repair gave up after ${PAUSED_REPAIR_MAX} attempts — passive watch only; will still auto-resume on recovery.`, "warning");
								systemNotify(`proxy still down after ${PAUSED_REPAIR_MAX} repair attempts — session paused; will auto-resume on recovery`);
							}
							return;
						}
						if (await repairProxy(sessionCtx)) {
							if (pausedByUs && !runActive && budgetLeft() > 0) {
								chargeBudget();
								pausedByUs = false;
								notify(sessionCtx, "Proxy repaired — resuming paused session.");
								if (NOTIFY_RESUME) systemNotify("proxy recovered — session resumed");
								pi.sendUserMessage(RESUME_TEXT, { deliverAs: "followUp" });
							} else {
								log("watchdog repaired proxy mid-run");
							}
						}
					} catch (err) {
						log(`watchdog error: ${err instanceof Error ? err.message : String(err)}`);
					} finally {
						ticking = false;
					}
				})();
			}, WATCHDOG_MS);
			watchdog.unref?.();
		}
	});

	pi.on("session_shutdown", () => {
		if (watchdog) {
			clearInterval(watchdog);
			watchdog = undefined;
		}
		sessionCtx = undefined;
		pausedByUs = false;
		runActive = false;
	});

	pi.on("agent_start", () => {
		runActive = true;
		pausedByUs = false; // whoever started the run, a fresh attempt is underway
	});
	pi.on("agent_settled", () => {
		runActive = false;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		// Clean settle resets both counters: a new incident deserves a full budget.
		if (event.outcome !== "error") {
			repairs = [];
			consecutiveErrors = 0;
			return;
		}
		if (busy) return;
		busy = true;
		try {
			consecutiveErrors++;
			// If the watchdog is mid-repair, ride on its result instead of starting another.
			await waitForRepair(SHORTCUT_TIMEOUT_MS + 30_000);

			log(
				`settle error #${consecutiveErrors}; canContinue=${event.context.canContinue}; ` +
					`budget=${budgetLeft()}/${MAX_REPAIRS}; pausedByUs=${pausedByUs}`,
			);
			if (budgetLeft() <= 0) {
				notify(ctx, `Auto-continue budget exhausted (${MAX_REPAIRS}/${Math.round(WINDOW_MS / 60_000)}min). Staying paused — take over manually.`, "warning");
				systemNotify("auto-continue budget exhausted — session paused; check proxy or take over");
				return;
			}

			const check = await probe();
			const halfDead = check.ok && consecutiveErrors >= ESCALATE_AFTER;

			if (!check.ok && !mayRepair()) {
				// Repair already gave up this down-episode — don't hammer Shortcuts.
				pausedByUs = true;
				notify(ctx, `Proxy down; active repairs exhausted (${PAUSED_REPAIR_MAX}). Passive watch until it's back.`, "error");
				systemNotify(`proxy down, repairs exhausted (${PAUSED_REPAIR_MAX}) — session paused`);
				return;
			}
			if (!check.ok || halfDead) {
				// Down, or ping-OK but streams keep dying -> repair.
				if (!(await repairProxy(ctx))) {
					// On the half-dead path the pre-repair check was OK: don't trust the
					// failed repair to mean we're offline — verify once more.
					const post = await probe();
					if (!post.ok) {
						pausedByUs = true;
						notify(ctx, "Proxy still down after repair attempts. Staying paused; watchdog will auto-resume once it's back.", "error");
						return;
					}
				}
				notify(ctx, halfDead ? "Half-dead node — repaired before continuing." : "Proxy restored. Auto-continuing…");
			} else if (BACKOFF_MS > 0) {
				await sleep(BACKOFF_MS);
				notify(ctx, `Proxy OK (HTTP ${check.status}). Auto-continuing after error…`);
			}

			chargeBudget();
			pausedByUs = false;

			// Errored assistant message = last context message -> canContinue=false.
			// Append a custom_message draft (projects to a `user` message) to unblock.
			const entries = event.context.canContinue
				? undefined
				: [{ type: "custom_message" as const, customType: NUDGE_CUSTOM_TYPE, content: NUDGE_TEXT, display: false }];
			return entries ? { entries, continue: true } : { continue: true };
		} finally {
			busy = false;
		}
	});

	pi.registerCommand("proxyguard", {
		description: "Proxy Guard: check/restart/status",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] || "check";
			if (sub === "check") {
				const check = await checkProxy();
				notify(
					ctx,
					check.ok ? `Proxy OK (HTTP ${check.status}, ${CHECK_URL})` : `Proxy DOWN (${check.error ?? `HTTP ${check.status}`}, ${CHECK_URL})`,
					check.ok ? "info" : "error",
				);
			} else if (sub === "restart") {
				const repaired = await repairProxy(ctx);
				notify(ctx, repaired ? "Proxy restored." : "Proxy still down after repair.", repaired ? "info" : "error");
			} else if (sub === "status") {
				notify(
					ctx,
					`url=${CHECK_URL} proxy=${CHECK_PROXY ?? "(env)"} shortcut="${SHORTCUT || "off"}" scheme=${USE_SCHEME ? "on" : "off"} ` +
						`escalateAfter=${ESCALATE_AFTER} budget=${budgetLeft()}/${MAX_REPAIRS}/${Math.round(WINDOW_MS / 60_000)}min ` +
						`watchdog=${WATCHDOG_MS}ms pausedByUs=${pausedByUs} consecErrs=${consecutiveErrors} failedRepairs=${failedRepairs}/${PAUSED_REPAIR_MAX} log=${LOG_FILE || "off"}`,
				);
			} else {
				notify(ctx, "Usage: /proxyguard [check|restart|status]", "warning");
			}
		},
	});
}
