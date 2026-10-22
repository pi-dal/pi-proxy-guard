import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseBackend, classifyProviderError, isLoopbackApiUrl, isLoopbackApiUrlLocal, loopbackUpstreamKind, shouldAttemptRecovery, shouldDeepProbe, transferHealthy, transportReached } from "../extensions/recovery-policy.ts";
import { findSupervisorSocket, supervisorStatus } from "../extensions/sakamoto-adapter.ts";

test("sakamoto is preferred; Shadowrocket is never an implicit fallback", () => {
	assert.equal(chooseBackend(undefined, true), "sakamoto");
	assert.equal(chooseBackend(undefined, false), "none");
	assert.equal(chooseBackend("sakamoto", false), "none");
	assert.equal(chooseBackend("shadowrocket", true), "shadowrocket");
	assert.equal(chooseBackend("bogus", true), "none");
});

test("only transport-like errors can propose recovery", () => {
	for (const message of ["HTTP 429 rate limit", "401 invalid api key", "insufficient_quota", "403 permission denied"]) {
		assert.equal(classifyProviderError(message), "provider", message);
	}
	for (const message of ["ECONNRESET", "Stream ended without finish_reason", "Retry failed after 5 attempts", "fetch failed"]) {
		assert.equal(classifyProviderError(message), "network", message);
	}
	assert.equal(classifyProviderError("tool compilation failed"), "unknown");
	assert.equal(shouldAttemptRecovery("provider", false, "sakamoto"), false);
	assert.equal(shouldAttemptRecovery("unknown", false, "sakamoto"), false);
	assert.equal(shouldAttemptRecovery("network", true, "sakamoto"), false);
	assert.equal(shouldAttemptRecovery("network", false, "none"), false);
	assert.equal(shouldAttemptRecovery("network", false, "sakamoto"), true);
});

test("real-world assistant errorMessage patterns classify correctly", () => {
	// Sampled from ~/.pi/agent/sessions logs — these were falling through to
	// "unknown" and spamming "Unclassified error" warnings.
	const network = [
		"server_error: Codex: connection lost mid-reply (unexpected EOF)",
		"Codex: connection lost mid-reply (unexpected EOF)",
		"terminated",
		"Operation aborted",
		"This operation was aborted",
		"Aborted",
		"Aborted after 1 retry attempt",
		"Connection error.",
		"Error reading response: malformed server-sent event JSON.",
		'magpie API error (502): {"code":null,"message":"Codex: Post \\"https://chatgpt.com/backend-api/codex/responses\\": read tcp 127.0.0.1:55324->127.0.0.1:2334: read: connection reset by peer"}',
		'server_error: Codex: Post "https://chatgpt.com/backend-api/codex/responses": dial tcp: lookup chatgpt.com: no such host',
		"Codex SSE response headers timed out after 300000ms",
		"Codex: connection lost mid-reply (stream error: stream ID 27; INTERNAL_ERROR; received from peer)",
	];
	for (const m of network) assert.equal(classifyProviderError(m), "network", m);

	const provider = [
		'magpie API error (502): {"code":null,"message":"Codex: x@y.z\'s sign-in has expired — add the account again to use it"}',
		'server_error: Codex: x@y.z\'s sign-in has expired — add the account again to use it',
		'magpie API error (401): {"code":null,"message":"Codex: Your authentication token has expired. Please try refreshing it."}',
		"Our servers are currently overloaded. Please try again later.",
		"Codex error: Our servers are currently overloaded. Please try again later.",
		'429: {"code":null,"message":"Devin: usage limit reached: Reached free model rate limit"}',
		"This content was flagged for possible cybersecurity risk.",
	];
	for (const m of provider) assert.equal(classifyProviderError(m), "provider", m);

	// Still genuinely unknown — must not be silently promoted.
	assert.equal(classifyProviderError("Cannot find module '/opt/x/y.js'"), "unknown");
	assert.equal(classifyProviderError("tool compilation failed"), "unknown");
});

test("loopback API targets are recognised (local gateway cannot be a proxy problem)", () => {
	for (const url of ["http://127.0.0.1:3425/v1", "http://localhost:3425", "http://[::1]:8080", "http://gw.localhost:9"]) {
		assert.equal(isLoopbackApiUrl(url), true, url);
	}
	for (const url of ["https://api.openai.com/v1", "https://relay.example.com/v1", undefined, "", "not a url"]) {
		assert.equal(isLoopbackApiUrl(url), false, url);
	}
});

test("proxy 502 and small error pages never pass sustained transfer", () => {
	assert.equal(transportReached(502), false);
	assert.equal(transportReached(401), true); // API host responded; not an authentication success.
	assert.equal(transferHealthy(200, 65_536, 60_000), true);
	assert.equal(transferHealthy(502, 65_536, 60_000), false);
	assert.equal(transferHealthy(200, 512, 60_000), false);
	assert.equal(transferHealthy(429, 65_536, 60_000), false);
});

test("loopback upstream classification: magpie-style remote gateway vs local model server", () => {
	// Remote loopback gateway (magpie dials out through the VPN) — the
	// default: no local-upstream probe configured.
	assert.equal(loopbackUpstreamKind("http://127.0.0.1:3425/v1", undefined), "remote");
	// Same-host upstream probe marks it local (llama.cpp/Ollama-style).
	assert.equal(loopbackUpstreamKind("http://127.0.0.1:3425/v1", "http://127.0.0.1:8080/health"), "local");
	assert.equal(isLoopbackApiUrlLocal("http://127.0.0.1:3425/v1", "http://localhost:8080/"), false); // hostname must match literally
	// A probe on another host is unusable → unknown (conservative).
	assert.equal(loopbackUpstreamKind("http://127.0.0.1:3425/v1", "http://192.168.1.5:8080/"), "unknown");
	// Non-loopback targets have no upstream kind.
	assert.equal(loopbackUpstreamKind("https://api.openai.com/v1", "http://127.0.0.1:8080/"), undefined);
});

test("a lone network settle never spends a deep probe", () => {
	assert.equal(shouldDeepProbe("network", 1, false, 2), false);
	assert.equal(shouldDeepProbe("network", 2, false, 2), true);
	assert.equal(shouldDeepProbe("network", 1, true, 2), true); // watchdog saw the path fail mid-run
	assert.equal(shouldDeepProbe("provider", 9, true, 2), false);
	assert.equal(shouldDeepProbe("unknown", 9, true, 2), false);
	assert.equal(shouldDeepProbe("network", 1, false, 1), true); // min=1 restores hair-trigger
});

test("supervisor adapter only issues a read-only status request", async () => {
	const dir = mkdtempSync(join(tmpdir(), "proxy-guard-svc-"));
	const path = join(dir, "svc.sock");
	const seen: string[] = [];
	const server = createServer((socket) => {
		socket.once("data", (data) => { seen.push(data.toString()); socket.end("connected pid=123 up=10s\n"); });
	});
	try {
		await new Promise<void>((resolve, reject) => server.listen(path, () => resolve()).once("error", reject));
		assert.equal(findSupervisorSocket(dir, dir), path);
		assert.equal(await supervisorStatus(path, 1_000), "connected");
		assert.deepEqual(seen, ["status\n"]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});
