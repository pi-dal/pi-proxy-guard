// Pure policy helpers: no shell commands, credentials, or active network writes.
export type Backend = "sakamoto" | "shadowrocket" | "none";
export type FailureKind = "network" | "provider" | "unknown";

/** Where the gateway's upstream actually lives. `remote` = the loopback
 *  gateway dials out through the VPN (e.g. magpie proxying to cloud
 *  providers): VPN/proxy state genuinely affects the Pi path, so deep
 *  probing and repair apply. `local` = the whole pipeline is local
 *  (llama.cpp, Ollama, …): proxy state is irrelevant. `unknown` = fall
 *  back to the legacy probe-less pause. */
export type LoopbackUpstream = "remote" | "local" | "unknown";

export function chooseBackend(requested: string | undefined, sakamotoAvailable: boolean): Backend {
	const mode = (requested ?? "auto").trim().toLowerCase();
	if (mode === "shadowrocket") return "shadowrocket"; // Explicit legacy opt-in only.
	if (mode === "sakamoto") return sakamotoAvailable ? "sakamoto" : "none";
	if (mode === "none") return "none";
	return mode === "auto" && sakamotoAvailable ? "sakamoto" : "none";
}

export function classifyProviderError(message: string): FailureKind {
	// Provider/account failures — retrying the network cannot help. Includes
	// upstream-auth, overload, usage-cap and prompt-shape errors surfaced
	// through gateways like magpie. Match `overloaded` loosely to also catch
	// `server_is_overloaded` codes and `prompt is too long` variants.
	if (/\b(?:401|402|403|429)\b|invalid[_ -]?api[_ -]?key|insufficient[_ -]?quota|rate[_ -]?limit|billing|payment[_ -]?required|model[_ -]?not[_ -]?found|context[_ -]?length|permission denied|sign-in has expired|authentication token has expired|servers are currently overloaded|server_is_overloaded|usage limit|prompt is too long|context window|content was flagged/i.test(message)) return "provider";
	// Transport failures — worth a deep probe + recovery path. Covers
	// mid-stream cuts, EOF/reset variants, aborts, SSE parse failures, DNS
	// misses, and read/write/dial timeouts seen in real logs. `read tc`/`dial tc`
	// are kept loose to survive truncated error strings.
	if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|TLS handshake|fetch failed|network error|stream ended without finish_reason|retry failed after \d+ attempts|connection lost mid-reply|unexpected EOF|\bEOF\b|\bterminated\b|\baborted\b|operation aborted|connection error|malformed server-sent event|websocket error|dial tc|read tc|write tc|i\/o timeout|no such host|request timed out|response headers timed out|stream error.*INTERNAL_ERROR|error occurred while processing your request|an internal error occurred/i.test(message)) return "network";
	return "unknown";
}

/** A loopback API target (e.g. a local gateway such as magpie on
 *  127.0.0.1:3425) can never be a proxy problem: VPN repair cannot reach
 *  it, cannot fix it, and must not run. Probing it is still meaningful
 *  for pause/auto-resume bookkeeping. */
export function isLoopbackApiUrl(url: string | undefined): boolean {
	return loopbackApiHostname(url) !== undefined;
}

function loopbackApiHostname(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const h = new URL(url).hostname.toLowerCase();
		return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h === "[::1]" ? h : undefined;
	} catch {
		return undefined;
	}
}

/** Optional probe used only for a *local* loopback upstream: a same-host
 *  endpoint that reports whether the local model server is up, so
 *  auto-resume can fire on its recovery instead of on proxy noise.
 *  Configured via PI_PROXY_GUARD_LOCAL_UPSTREAM_URL; any HTTP response
 *  counts as alive (only the process needs to answer). */
export function isLoopbackApiUrlLocal(url: string | undefined, localUpstreamUrl: string | undefined): boolean {
	if (!localUpstreamUrl) return false;
	const api = loopbackApiHostname(url);
	if (!api) return false;
	const local = loopbackApiHostname(localUpstreamUrl);
	// A local upstream must live on the same host as the gateway itself;
	// anything else makes no sense as "the model server Pi's gateway uses".
	return local === api;
}

/** Resolve the upstream kind of a loopback API target. A non-loopback
 *  target is remote by definition. An *explicit* loopbackUpstreamUrl
 *  wins; otherwise same-host loopbackUpstreamUrl (from the env) marks it
 *  local. No hint configured = unknown (legacy behavior). */
export function loopbackUpstreamKind(apiUrl: string | undefined, loopbackUpstreamUrl: string | undefined): LoopbackUpstream | undefined {
	if (!isLoopbackApiUrl(apiUrl)) return undefined;
	if (!loopbackUpstreamUrl) return "remote";
	// A configured local-upstream probe on a different host is misconfigured
	// (or deliberately points at a LAN box); either way we cannot classify
	// it from here — stay with the legacy unknown-pause path.
	return isLoopbackApiUrlLocal(apiUrl, loopbackUpstreamUrl) ? "local" : "unknown";
}

// A 502 from a proxy is not proof that the requested HTTPS path works.
export function transportReached(status: number): boolean {
	return status >= 200 && status < 500;
}

export function transferHealthy(status: number, bytes: number, minimumBytes: number): boolean {
	return status >= 200 && status < 300 && Number.isFinite(bytes) && bytes >= minimumBytes;
}

/** A failed settle cannot be trusted to mean the network died. Require
 *  either a consecutive network settle streak or explicit transport
 *  evidence before spending a deep probe / touching anything. Pi's own
 *  provider-retry pipeline already absorbed the first transient blip —
 *  one error reaching settle is usually an upstream cut the proxy cannot
 *  fix anyway. */
export function shouldDeepProbe(kind: FailureKind, consecutiveErrors: number, networkEvidence: boolean, minConsecutive: number): boolean {
	if (kind !== "network") return false;
	return networkEvidence || consecutiveErrors >= Math.max(1, minConsecutive);
}

export function shouldAttemptRecovery(kind: FailureKind, deepCheckOk: boolean, backend: Backend): boolean {
	return kind === "network" && !deepCheckOk && backend !== "none";
}
