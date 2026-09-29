// Read-only sakamoto supervisor adapter. It never selects a node, restarts the
// tunnel, or reads the private sing-box API credential.
import { statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export type SupervisorState = "connected" | "disconnected" | "unknown";

export function findSupervisorSocket(directory = process.env.SAKAMOTO_DIR, home = homedir()): string | undefined {
	const candidates = [
		...(directory ? [join(directory, "svc.sock")] : []),
		join(home, ".config", "sakamoto", "svc.sock"),
		join(home, ".sakamoto", "svc.sock"),
	];
	for (const path of new Set(candidates)) {
		try { if (statSync(path).isSocket()) return path; } catch { /* not running here */ }
	}
	return undefined;
}

export function supervisorStatus(path: string, timeoutMs = 2_000): Promise<SupervisorState> {
	return new Promise((resolve) => {
		const socket = createConnection({ path });
		let settled = false;
		let reply = "";
		const done = (result: SupervisorState): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs, () => done("unknown"));
		socket.on("connect", () => socket.write("status\n"));
		socket.on("data", (data: Buffer) => {
			reply += data.toString("utf8");
			if (reply.length > 256) return done("unknown");
			if (reply.startsWith("connected")) return done("connected");
			if (reply.startsWith("disconnected")) return done("disconnected");
			if (reply.includes("\n")) done("unknown");
		});
		socket.on("error", () => done("unknown"));
		socket.on("close", () => done("unknown"));
	});
}
