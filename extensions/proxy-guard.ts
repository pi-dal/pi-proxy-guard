/**
 * Proxy Guard — conservative Pi session recovery, with sakamoto as the default
 * backend when its local supervisor socket exists. Shadowrocket repair requires
 * the explicit PI_PROXY_GUARD_BACKEND=shadowrocket legacy setting.
 *
 * Only a classified network/stream error may trigger recovery. Three spaced
 * attempts check the Pi API host and a sustained transfer on the same proxy
 * path; two independent deep successes are required before continuing Pi.
 * Quota/auth/unclassified errors stay paused without switching anything.
 *
 * With sakamoto, this extension never selects a node, starts/stops a VPN, or
 * reads the native API secret. The existing sakamoto watcher exclusively owns
 * RealityAuto/OthersAuto fallback and preserves ManualPick. Observe mode
 * (default) stays paused and watches; recover mode issues one `sakamoto
 * recover` request for fresh watcher-owned tests, then waits one interval
 * before deep verification. A broken chained SOCKS exit cannot be repaired by
 * selecting a different entry and must be reported rather than bounced.
 *
 * Pi's agent_before_settle boundary cannot continue a failed assistant turn
 * without a new message when context.canContinue is false. On VERIFIED
 * recovery we append a hidden custom_message draft and request one continuation.
 * The watchdog verifies the full deep path twice before resuming a pause.
 * All loops have cooldown, per-incident repair caps and a rolling provider
 * request budget. See README.md for configuration and limitations.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chooseBackend, classifyProviderError, isLoopbackApiUrl, shouldAttemptRecovery, transferHealthy, transportReached, type Backend } from "./recovery-policy.ts";
import { findSupervisorSocket, supervisorStatus } from "./sakamoto-adapter.ts";

/** Shell rc files occasionally wrap a value in literal quotes
 *  (`export VAR="\"https://…\""`), which hands tools like curl a
 *  malformed URL (exit 3). Strip one surrounding quote pair. */
function envStr(name: string, fallback = ""): string {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const t = raw.trim();
	return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1) : t;
}

const DISABLED = envStr("PI_PROXY_GUARD") === "0";
const CHECK_URL = envStr("PI_PROXY_GUARD_URL", "https://www.google.com/generate_204");
const API_URL_OVERRIDE = envStr("PI_PROXY_GUARD_API_URL") || undefined;
const STREAM_URL = envStr("PI_PROXY_GUARD_STREAM_URL", "https://speed.cloudflare.com/__down?bytes=65536");
const STREAM_MIN_BYTES = Number(process.env.PI_PROXY_GUARD_STREAM_MIN_BYTES ?? 60_000);
const VPN_SERVICE = envStr("PI_PROXY_GUARD_VPN_SERVICE");
const CHECK_PROXY = envStr("PI_PROXY_GUARD_PROXY") || undefined;
const CHECK_TIMEOUT_MS = Number(process.env.PI_PROXY_GUARD_TIMEOUT_MS ?? 20_000);
const PROBE_ATTEMPTS = Number(process.env.PI_PROXY_GUARD_PROBE_ATTEMPTS ?? 3);
const PROBE_GAP_MS = Number(process.env.PI_PROXY_GUARD_PROBE_GAP_MS ?? 1_500);
const BACKEND_REQUEST = envStr("PI_PROXY_GUARD_BACKEND") || undefined;
const SAKAMOTO_MODE = envStr("PI_PROXY_GUARD_SAKAMOTO_MODE") === "recover" ? "recover" : "observe";
const SAKAMOTO_WAIT_MS = Number(process.env.PI_PROXY_GUARD_SAKAMOTO_WAIT_MS ?? 45_000);
const SAKAMOTO_BIN = envStr("PI_PROXY_GUARD_SAKAMOTO_BIN", "sakamoto");
const SHORTCUT = envStr("PI_PROXY_GUARD_SHORTCUT", "Reconnect Shadowrocket");
const SHORTCUT_TIMEOUT_MS = Number(process.env.PI_PROXY_GUARD_SHORTCUT_TIMEOUT_MS ?? 120_000);
const USE_SCHEME = process.env.PI_PROXY_GUARD_SCHEME !== "0";
// Verified against Shadowrocket's docs: connect/disconnect (not start/stop).
// autoclose=true lets the app quit itself after handling the action.
const SCHEME_STOP = envStr("PI_PROXY_GUARD_SCHEME_STOP", "shadowrocket://disconnect?autoclose=true");
const SCHEME_START = envStr("PI_PROXY_GUARD_SCHEME_START", "shadowrocket://connect?autoclose=true");
const PAUSED_REPAIR_MAX = Number(process.env.PI_PROXY_GUARD_PAUSED_REPAIRS ?? 3);
const REPAIR_COOLDOWN_MS = Number(process.env.PI_PROXY_GUARD_REPAIR_COOLDOWN_MS ?? 90_000);
const RECHECK_DELAY_MS = Number(process.env.PI_PROXY_GUARD_RECHECK_DELAY_MS ?? 8_000);
const BACKOFF_MS = Number(process.env.PI_PROXY_GUARD_BACKOFF_MS ?? 3_000);
const MAX_REPAIRS = Number(process.env.PI_PROXY_GUARD_MAX_REPAIRS ?? 5);
const WINDOW_MS = Number(process.env.PI_PROXY_GUARD_WINDOW_MS ?? 600_000);
const WATCHDOG_MS = Number(process.env.PI_PROXY_GUARD_WATCHDOG_MS ?? 60_000);
const NOTIFY_CHANNELS_RAW = envStr("PI_PROXY_GUARD_NOTIFY", "macos,bark,webhook");
const NOTIFY_CHANNELS = NOTIFY_CHANNELS_RAW === "0" || NOTIFY_CHANNELS_RAW === "off"
	? []
	: NOTIFY_CHANNELS_RAW.split(",").map((s) => s.trim()).filter(Boolean);
const NOTIFY_RESUME = envStr("PI_PROXY_GUARD_NOTIFY_RESUME") === "1";
const NOTIFY_COOLDOWN_MS = Number(process.env.PI_PROXY_GUARD_NOTIFY_COOLDOWN_MS ?? 600_000);
const BARK = envStr("PI_PROXY_GUARD_BARK");
const WEBHOOK = envStr("PI_PROXY_GUARD_WEBHOOK");
const PUSH_TITLE = "pi proxy-guard";
/** Push a "Pi finished" notification only for clean completes lasting >=
 *  this long. 0 disables. Beats pi-bark's blanket agent_settled push:
 *  outcome-aware (no false "finished" on error settles) + duration gate. */
const NOTIFY_FINISH_MS = Number(process.env.PI_PROXY_GUARD_NOTIFY_FINISH_MS ?? 0);
const LOG_FILE =
	process.env.PI_PROXY_GUARD_LOG === "" || envStr("PI_PROXY_GUARD_LOG") === ""
		? process.env.PI_PROXY_GUARD_LOG === "" ? "" : join(homedir(), ".pi", "agent", "proxy-guard.log")
		: envStr("PI_PROXY_GUARD_LOG");

const NUDGE_CUSTOM_TYPE = "proxy-guard-recovery";
const NUDGE_TEXT =
	"[proxy-guard] The previous model request failed with a network error (stream cut, retries exhausted). " +
	"Connectivity has been verified again. Continue exactly where you left off.";
const RESUME_TEXT = "continue";

function originLabel(value: string | undefined): string {
	if (!value) return "(none)";
	try {const u=new URL(value);return `${u.protocol}//${u.host}`;} catch {return "(configured)";}
}

function log(message: string): void {
	if (!LOG_FILE) return;
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
		try {chmodSync(LOG_FILE,0o600);} catch { /* newly created by appendFileSync */ }
		appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
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
	repairable?: boolean;
}

function execCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output?: string; error?: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
			// ChildProcess error.message can contain command arguments, including
			// private webhook URLs. Never log commands or URLs on failure.
			resolve(err
				? { ok: false, output: stdout, error: `command failed (${String((err as NodeJS.ErrnoException).code ?? "unknown")})` }
				: { ok: true, output: stdout });
		});
	});
}

/** Reachability probe: any HTTP response (even 404/401/502) means the
 *  transport path to the host is alive — that's what we measure, not
 *  whether the endpoint "succeeds". */
function httpProbe(url: string, requireSuccess = false): Promise<CheckResult> {
	return new Promise((resolve) => {
		const args = ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", String(Math.ceil(CHECK_TIMEOUT_MS / 1000))];
		if (CHECK_PROXY) args.push("-x", CHECK_PROXY);
		args.push(url);
		execFile("curl", args, { timeout: CHECK_TIMEOUT_MS + 2_000 }, (err, stdout) => {
			const status = Number.parseInt((stdout ?? "").trim(), 10);
			if (!err && (requireSuccess ? status >= 200 && status < 300 : transportReached(status))) resolve({ ok: true, status });
			else resolve({ ok: false, status: Number.isFinite(status) ? status : undefined, error: `curl failed (${String((err as NodeJS.ErrnoException | null)?.code ?? "unknown")})` });
		});
	});
}

/** Sustained-transfer probe: downloads STREAM_URL and requires the body to
 *  actually arrive (>= STREAM_MIN_BYTES). A half-dead chain that passes tiny
 *  pings but cuts long-lived streams gets caught here. */
function streamProbe(url: string): Promise<CheckResult> {
	return new Promise((resolve) => {
		const args = ["-sS", "-o", "/dev/null", "-w", "%{http_code} %{size_download}", "--max-time", String(Math.ceil(CHECK_TIMEOUT_MS / 1000))];
		if (CHECK_PROXY) args.push("-x", CHECK_PROXY);
		args.push(url);
		execFile("curl", args, { timeout: CHECK_TIMEOUT_MS + 2_000 }, (err, stdout) => {
			const [statusRaw, bytesRaw] = (stdout ?? "").trim().split(/\s+/);
			const status = Number.parseInt(statusRaw, 10);
			const bytes = Number.parseInt(bytesRaw, 10);
			if (!err && transferHealthy(status, bytes, STREAM_MIN_BYTES)) resolve({ ok: true, status });
			else
				resolve({
					ok: false,
					status: Number.isFinite(status) ? status : undefined,
					error: err ? `curl stream failed (${String((err as NodeJS.ErrnoException).code ?? "unknown")})` : `stream cut: got ${bytes}B < ${STREAM_MIN_BYTES}B`,
				});
		});
	});
}

/** Optional fast path: local sakamoto supervisor or an explicit legacy VPN service. */
async function tunnelUp(backend: Backend, socketPath?: string): Promise<boolean | undefined> {
	if (backend === "sakamoto") {
		if (!socketPath) return false;
		return (await supervisorStatus(socketPath)) === "connected";
	}
	if (backend !== "shadowrocket" || !VPN_SERVICE) return undefined;
	const r = await execCmd("scutil", ["--nc", "show", VPN_SERVICE], 5_000);
	if (!r.ok || r.output === undefined) return undefined;
	return /\bConnected\b/.test(r.output) ? true : /\bDisconnected\b/.test(r.output) ? false : undefined;
}

/** Back-compat shim: reachability via the configured CHECK_URL. */
function checkProxy(): Promise<CheckResult> {
	return httpProbe(CHECK_URL, true);
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
	let runStartedAt = 0;
	/** outcome of the most recent settle boundary; agent_settled has none. */
	let lastSettleOutcome = "";
	/** Session-scoped watchdog + captured context. */
	let watchdog: ReturnType<typeof setInterval> | undefined;
	let sessionCtx: ExtensionContext | undefined;
	let sessionToken=0;
	let supervisorSocket: string | undefined;
	let backend: Backend = "none";

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
		pushNow(body);
	}

	/** Duration-gated finish push; shares channels, unthrottled. */
	function finishNotify(body: string): void {
		if (NOTIFY_CHANNELS.length === 0 || NOTIFY_FINISH_MS <= 0) return;
		pushNow(body);
	}

	function pushNow(body: string): void {
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

	/** checkProxy + episode bookkeeping: an OK probe resets the repair counter.
	 *  A single failure never means "down" on a wobbly chain proxy — we
	 *  require PROBE_ATTEMPTS consecutive failures before declaring dead.
	 *  This prevents latency spikes from triggering needless VPN bounces
	 *  (which would kill the very streams we're trying to protect).
	 *
	 *  deep=true (settle/recheck): probes the actual API host (ctx.model.baseUrl
	 *  or PI_PROXY_GUARD_API_URL) and adds a sustained-transfer check — the
	 *  "can it hold an SSE stream" signal a 0-byte ping can't see.
	 *  deep=false (watchdog): cheap generate_204 ping only. */
	async function probe(ctx?: ExtensionContext, deep = false, resetEpisode = true): Promise<CheckResult> {
		const target = (deep ? (API_URL_OVERRIDE ?? ctx?.model?.baseUrl) : undefined) ?? CHECK_URL;
		// A loopback API target (a local gateway such as magpie) is not reached
		// through the VPN: skip the tunnel gate and the sustained-transfer check
		// — a dead proxy must not mask "the local gateway is back up".
		const loopback = deep && isLoopbackApiUrl(target);
		if (!loopback) {
			const vpn = await tunnelUp(backend, supervisorSocket);
			if (vpn === false) return { ok: false, repairable: backend !== "sakamoto", error: backend === "sakamoto" ? "sakamoto supervisor is not connected" : `VPN tunnel "${VPN_SERVICE}" disconnected` };
		}
		let last: CheckResult = { ok: false };
		for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
			last = await httpProbe(target, !deep);
			if (last.ok && deep && !loopback && STREAM_MIN_BYTES > 0) {
				const stream = await streamProbe(STREAM_URL);
				if (!stream.ok) last = stream;
			}
			if (last.ok) {
				if (deep && resetEpisode) {failedRepairs=0;gaveUpNotified=false;}
				return last;
			}
			if (attempt < PROBE_ATTEMPTS) {
				log(`probe attempt ${attempt}/${PROBE_ATTEMPTS} failed (${last.error ?? `HTTP ${last.status}`}); retrying`);
				await sleep(PROBE_GAP_MS);
			}
		}
		return last;
	}

	/** Require two independent sustained-transfer successes before resuming Pi
	 * after a paused network error or an attempted failover. */
	async function verifyRecovery(ctx: ExtensionContext): Promise<CheckResult> {
		const first=await probe(ctx,true,false);
		if (!first.ok) return first;
		if (PROBE_GAP_MS>0) await sleep(PROBE_GAP_MS);
		const second=await probe(ctx,true,false);
		if (second.ok) {failedRepairs=0;gaveUpNotified=false;}
		return second;
	}

	/** True while we may still launch an active repair this down-episode. */
	const mayRepair = (): boolean => failedRepairs < PAUSED_REPAIR_MAX;

	/** The sakamoto watcher alone owns MainProxy selection. The guard may wait
	 * for its existing URLTest/fallback interval, but never writes a selector. */
	async function repairProxy(ctx: ExtensionContext): Promise<boolean> {
		const token=sessionToken;
		// Loopback API targets are unreachable by definition of VPN repair.
		if (isLoopbackApiUrl(API_URL_OVERRIDE ?? ctx.model?.baseUrl)) {
			log("loopback API target — proxy repair skipped");
			return false;
		}
		if (backend === "none" || (backend === "sakamoto" && SAKAMOTO_MODE !== "recover")) return false;
		if (Date.now() - lastRepairAt < REPAIR_COOLDOWN_MS) {
			log("repair skipped: cooldown");
			return false;
		}
		repairing = true;
		lastRepairAt = Date.now();
		failedRepairs++;
		try {
			if (backend === "sakamoto") {
				const request=await execCmd(SAKAMOTO_BIN,["recover"],5_000);
				if (token!==sessionToken) return false;
				if (!request.ok) {notify(ctx,`sakamoto recovery trigger unavailable: ${request.error}`,"warning");return false;}
				const status=(request.output??"").trim();
				if (!["queued","busy","cooldown"].includes(status)) {
					notify(ctx,`sakamoto did not queue a switch (${status || "unknown"}); ManualPick and disabled fallback are never overridden.`,"warning");
					return false;
				}
				notify(ctx,`sakamoto recovery ${status}; waiting for watcher-owned URL tests (no VPN restart)…`,"warning");
				await sleep(Math.max(0, SAKAMOTO_WAIT_MS));
				if (token!==sessionToken) return false;
				const check = await verifyRecovery(ctx);
				if (!check.ok) log(`sakamoto watcher did not recover the Pi path: ${check.error ?? `HTTP ${check.status}`}`);
				return check.ok;
			}
			const recheck = async (): Promise<boolean> => {
				await sleep(RECHECK_DELAY_MS);
				const check = await verifyRecovery(ctx); // confirm sustained capacity twice
				if (!check.ok) log(`still down: ${check.error ?? `HTTP ${check.status}`}`);
				return check.ok;
			};
			const viaShortcut = async (): Promise<boolean> => {
				if (!SHORTCUT || token!==sessionToken) return false;
				notify(ctx, `Running shortcut "${SHORTCUT}"…`, "warning");
				const res = await execCmd("shortcuts", ["run", SHORTCUT], SHORTCUT_TIMEOUT_MS);
				if (!res.ok) {
					log(`shortcut failed: ${res.error}`);
					return false;
				}
				return recheck();
			};
			const viaScheme = async (): Promise<boolean> => {
				if (!USE_SCHEME || token!==sessionToken) return false;
				notify(ctx, "Bouncing Shadowrocket via URL scheme…", "warning");
				// `open -g`: background — do NOT activate/foreground Shadowrocket.
				const stop = await execCmd("open", ["-g", SCHEME_STOP], 15_000);
				if (!stop.ok) {
					log(`scheme stop failed: ${stop.error}`);
					return false;
				}
				await sleep(3_000);
				const start = await execCmd("open", ["-g", SCHEME_START], 15_000);
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
		sessionToken++;
		sessionCtx = ctx;
		supervisorSocket = findSupervisorSocket();
		backend = chooseBackend(BACKEND_REQUEST, Boolean(supervisorSocket));
		log(`backend=${backend} mode=${backend === "sakamoto" ? SAKAMOTO_MODE : "legacy"}`);
		pausedByUs = false;
		repairs = [];
		consecutiveErrors = 0;
		runActive = false;
		if (WATCHDOG_MS > 0 && !watchdog) {
			watchdog = setInterval(() => {
				void (async () => {
					if (ticking || busy || repairing || !sessionCtx) return;
					const token=sessionToken;
					// Only spend effort when pi actually needs the connection:
					// a live run (internal retries benefit) or a paused-by-us session.
					if (!runActive && !pausedByUs) return;
					ticking = true;
					try {
						const check = pausedByUs ? await verifyRecovery(sessionCtx) : await probe(sessionCtx, false);
						if (token!==sessionToken || !sessionCtx) return;
						if (check.ok) {
							// Recovered while paused: resume.
							if (pausedByUs && !runActive) {
								if (budgetLeft() <= 0) return;
								chargeBudget();
								pausedByUs = false;
								notify(sessionCtx, "Proxy verified by deep check — resuming paused session.");
								if (NOTIFY_RESUME) systemNotify("proxy recovered — session resumed");
								pi.sendUserMessage(RESUME_TEXT, { deliverAs: "followUp" });
							}
							return;
						}
						// Down: active repairs are capped at PAUSED_REPAIR_MAX per
						// down-episode; afterwards we keep a cheap passive watch and
						// still auto-resume when the proxy recovers on its own.
						if (check.repairable === false || backend === "none" || (backend === "sakamoto" && SAKAMOTO_MODE === "observe")) return;
						if (!mayRepair()) {
							if (!gaveUpNotified) {
								gaveUpNotified = true;
								notify(sessionCtx, `Active repair gave up after ${PAUSED_REPAIR_MAX} attempts — passive watch only; will still auto-resume on recovery.`, "warning");
								systemNotify(`proxy still down after ${PAUSED_REPAIR_MAX} repair attempts — session paused; will auto-resume on recovery`);
							}
							return;
						}
						// Repairing the network is free — only resumes/continues spend
						// provider requests, so the budget gates those, not the repair.
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
		sessionToken++;
		if (watchdog) {
			clearInterval(watchdog);
			watchdog = undefined;
		}
		sessionCtx = undefined;
		supervisorSocket = undefined;
		backend = "none";
		pausedByUs = false;
		runActive = false;
	});

	pi.on("agent_start", () => {
		runActive = true;
		runStartedAt = Date.now();
		pausedByUs = false; // whoever started the run, a fresh attempt is underway
	});
	pi.on("agent_settled", (_event, ctx) => {
		runActive = false;
		// Genuine completion (not a failure disguised as "finished", like
		// pi-bark's blanket settle push) that took a while — worth notifying;
		// quick interactive turns are not.
		if (NOTIFY_FINISH_MS > 0 && lastSettleOutcome === "completed" && runStartedAt > 0 && ctx.isIdle()) {
			const mins = (Date.now() - runStartedAt) / 60_000;
			if (Date.now() - runStartedAt >= NOTIFY_FINISH_MS) {
				finishNotify(`Pi finished — run took ${mins.toFixed(1)}min`);
			}
		}
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		// Clean settle resets both counters: a new incident deserves a full budget.
		lastSettleOutcome = event.outcome;
		if (event.outcome !== "error") {
			repairs = [];
			consecutiveErrors = 0;
			return;
		}
		if (busy) return;
		busy = true;
		const token=sessionToken;
		try {
			// The boundary exposes an outcome, not a failure category. Only the
			// assistant's final errorMessage is examined; never log prompt content.
			const lastAssistant = [...event.context.contextMessages].reverse().find((message) => message.role === "assistant");
			const kind = classifyProviderError(lastAssistant?.role === "assistant" ? (lastAssistant.errorMessage ?? "") : "");
			if (kind !== "network") {
				pausedByUs = false;
				notify(ctx, `${kind === "provider" ? "Provider/account" : "Unclassified"} error; no proxy recovery or automatic continuation.`, "warning");
				return;
			}
			consecutiveErrors++;
			await waitForRepair(SHORTCUT_TIMEOUT_MS + 30_000);
			if (token!==sessionToken) return;
			log(`network settle #${consecutiveErrors}; canContinue=${event.context.canContinue}; budget=${budgetLeft()}/${MAX_REPAIRS}; backend=${backend}`);
			const check = await verifyRecovery(ctx); // API host plus two sustained transfers.
			if (token!==sessionToken) return;
			if (!check.ok && isLoopbackApiUrl(API_URL_OVERRIDE ?? ctx.model?.baseUrl)) {
				// e.g. magpie's gateway stopped: VPN repair cannot reach a loopback
				// target. Stay paused; the watchdog's deep probes auto-resume the
				// session once it answers again.
				pausedByUs = true;
				notify(ctx, "API target is loopback — proxy recovery cannot apply. Pausing; auto-resume once the local endpoint answers.", "warning");
				return;
			}
			if (budgetLeft() <= 0) {
				pausedByUs = !check.ok;
				notify(ctx, `Auto-continue budget exhausted (${MAX_REPAIRS}/${Math.round(WINDOW_MS / 60_000)}min). Staying paused.`, "warning");
				systemNotify("auto-continue budget exhausted — session paused; check proxy or take over");
				return;
			}
			if (!check.ok) {
				if (check.repairable === false) {
					pausedByUs = true;
					notify(ctx, "sakamoto is disconnected. Waiting for a manual connection; the guard will not start the VPN.", "warning");
					return;
				}
				if (backend === "sakamoto" && SAKAMOTO_MODE === "observe") {
					pausedByUs = true;
					notify(ctx, "Pi path down; sakamoto owns failover. Observe-only mode: no selector or tunnel changes.", "warning");
					return;
				}
				if (!mayRepair()) {
					pausedByUs = true;
					notify(ctx, `Recovery attempts exhausted (${PAUSED_REPAIR_MAX}); passive deep verification continues.`, "error");
					systemNotify(`proxy path still down after ${PAUSED_REPAIR_MAX} checks — session paused`);
					return;
				}
				const recovered = shouldAttemptRecovery(kind, check.ok, backend) && await repairProxy(ctx);
				if (token!==sessionToken) return;
				if (!recovered) {
					pausedByUs = true;
					notify(ctx, "Proxy path still down. Staying paused; deep watchdog checks will resume on recovery.", "error");
					return;
				}
				notify(ctx, "Pi proxy path verified after recovery; continuing.");
			} else if (BACKOFF_MS > 0) {
				await sleep(BACKOFF_MS);
				notify(ctx, `Pi proxy path verified (HTTP ${check.status}); continuing after transient error.`);
			}

			if (token!==sessionToken) return;
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
		description: "Proxy Guard: check/recover/status",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] || "check";
			if (sub === "check") {
				const check = await probe(ctx, true);
				notify(
					ctx,
					check.ok ? `Proxy OK (HTTP ${check.status})` : `Proxy DOWN (${check.error ?? `HTTP ${check.status}`})`,
					check.ok ? "info" : "error",
				);
			} else if (sub === "recover" || sub === "restart") {
				if (backend === "sakamoto" && SAKAMOTO_MODE === "observe") {
					notify(ctx, "Observe-only: sakamoto's watcher owns selection. No VPN restart or node switch requested.");
				} else {
					const recovered = await repairProxy(ctx);
					notify(ctx, recovered ? "Pi proxy path verified." : "Pi proxy path still down; no automatic continuation.", recovered ? "info" : "warning");
				}
			} else if (sub === "status") {
				notify(
					ctx,
					`backend=${backend} sakamotoMode=${backend === "sakamoto" ? SAKAMOTO_MODE : "n/a"} ping=${originLabel(CHECK_URL)} api=${originLabel(API_URL_OVERRIDE ?? ctx.model?.baseUrl)} stream=${STREAM_MIN_BYTES > 0 ? originLabel(STREAM_URL) : "off"} vpn=${backend === "shadowrocket" ? (VPN_SERVICE || "off") : "sakamoto/none"} ` +
						`proxy=${CHECK_PROXY ? originLabel(CHECK_PROXY) : "(env)"} shortcut="${backend === "shadowrocket" ? (SHORTCUT || "off") : "disabled"}" scheme=${backend === "shadowrocket" && USE_SCHEME ? "on" : "off"} ` +
						`budget=${budgetLeft()}/${MAX_REPAIRS}/${Math.round(WINDOW_MS / 60_000)}min ` +
						`watchdog=${WATCHDOG_MS}ms pausedByUs=${pausedByUs} consecErrs=${consecutiveErrors} failedRepairs=${failedRepairs}/${PAUSED_REPAIR_MAX} log=${LOG_FILE || "off"}`,
				);
			} else {
				notify(ctx, "Usage: /proxyguard [check|recover|status] (restart remains a legacy alias)", "warning");
			}
		},
	});
}
