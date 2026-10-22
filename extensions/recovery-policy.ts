// Pure policy helpers: no shell commands, credentials, or active network writes.
export type Backend = "sakamoto" | "shadowrocket" | "none";
export type FailureKind = "network" | "provider" | "unknown";

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
	if (!url) return false;
	try {
		const h = new URL(url).hostname.toLowerCase();
		return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" || h === "[::1]";
	} catch {
		return false;
	}
}

// A 502 from a proxy is not proof that the requested HTTPS path works.
export function transportReached(status: number): boolean {
	return status >= 200 && status < 500;
}

export function transferHealthy(status: number, bytes: number, minimumBytes: number): boolean {
	return status >= 200 && status < 300 && Number.isFinite(bytes) && bytes >= minimumBytes;
}

export function shouldAttemptRecovery(kind: FailureKind, deepCheckOk: boolean, backend: Backend): boolean {
	return kind === "network" && !deepCheckOk && backend !== "none";
}
