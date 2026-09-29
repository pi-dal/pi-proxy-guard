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
	if (/\b(?:401|402|403|429)\b|invalid[_ -]?api[_ -]?key|insufficient[_ -]?quota|rate[_ -]?limit|billing|payment[_ -]?required|model[_ -]?not[_ -]?found|context[_ -]?length|permission denied/i.test(message)) return "provider";
	if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|TLS handshake timeout|fetch failed|network error|stream ended without finish_reason|retry failed after \d+ attempts/i.test(message)) return "network";
	return "unknown";
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
