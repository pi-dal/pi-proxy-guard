import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseBackend, classifyProviderError, shouldAttemptRecovery, transferHealthy, transportReached } from "../extensions/recovery-policy.ts";
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

test("proxy 502 and small error pages never pass sustained transfer", () => {
	assert.equal(transportReached(502), false);
	assert.equal(transportReached(401), true); // API host responded; not an authentication success.
	assert.equal(transferHealthy(200, 65_536, 60_000), true);
	assert.equal(transferHealthy(502, 65_536, 60_000), false);
	assert.equal(transferHealthy(200, 512, 60_000), false);
	assert.equal(transferHealthy(429, 65_536, 60_000), false);
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
