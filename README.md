# pi-proxy-guard

Auto-recover [pi](https://github.com/earendil-works/pi) sessions when the proxy drops mid-run.

When all provider retries fail (`Retry failed after N attempts` / `Stream ended without finish_reason`), pi pauses the session. This extension:

1. **Checks connectivity**, two tiers: the watchdog uses a cheap ping (`generate_204` through the same `https_proxy` env pi uses); at settle/recheck time it does a **deep probe** — API host reachability (`ctx.model.baseUrl`, any HTTP response counts) **plus a sustained-transfer check** (`STREAM_MIN_BYTES` from `STREAM_URL`) — the signal a 0-byte ping can't see: whether the chain can actually hold a streaming connection. 'Down' requires `PROBE_ATTEMPTS` consecutive failures.
2. **Auto-continues** the run if the proxy is fine (transient stream cut).
3. **Repairs the proxy** if it's down — runs a macOS Shortcuts shortcut, falls back to `shadowrocket://` URL schemes — then continues once connectivity is verified.
4. **Watchdog**: if pi is still paused, it keeps watching; once the proxy is verified healthy again it sends `continue` itself. It also repairs the proxy while pi is mid-retry, so many incidents never reach the pause at all.
   - **If the proxy stays down**: at most `PAUSED_REPAIRS` (default 3) active repair attempts per down-episode; afterwards it switches to a cheap passive watch (one curl per `WATCHDOG_MS`) and **still auto-resumes** the moment the proxy verifies OK — e.g. after you fix it manually. It never gives up on resuming, it just stops hammering Shortcuts.
6. **Notifications**: on *repeated* failure (active repairs exhausted, or continue-budget exhausted) it pushes a notification — to your iPhone via Bark, a generic webhook, and/or macOS Notification Center. Push traffic bypasses the proxy (`--noproxy '*'`) so it reaches you even while the proxy is dead. Push bodies start with `💻 <hostname>` + `📁 <cwd>` so pushes from pi-sync'd machines are attributable.

## Notifications (iPhone)

1. Install [Bark](https://bark.day.app) on your iPhone, copy the push URL it shows (like `https://api.day.app/AbCdEfGhIjKlMnOpQr/`).
2. Export once (shell rc) or per-launch:
   ```bash
   export PI_PROXY_GUARD_BARK="https://api.day.app/<your-device-key>"
   ```
   Push uses Bark's POST form (`title`/`body`/`group`/`level=timeSensitive`), requests are `curl --noproxy '*' -m 10`.
3. Optional generic webhook (Pushcut / 企业微信 / n8n — POSTs `{"title","body"}`):
   ```bash
   export PI_PROXY_GUARD_WEBHOOK="https://your.webhook/endpoint"
   ```

Channels: `PI_PROXY_GUARD_NOTIFY="macos,bark,webhook"` (default; unconfigured channels are skipped), `"0"` silences all. Pushes are throttled to one per `NOTIFY_COOLDOWN_MS` (10min) — while things stay broken it acts as a periodic reminder.
5. **Half-dead node detection**: if the health check passes but streams keep cutting (≥ `ESCALATE_AFTER` consecutive error settles), it repairs anyway — a flapping node is usually not the same as a dead one.
6. **Anti-loop budget**: at most `MAX_REPAIRS` auto-continues per `WINDOW_MS` (rolling). Exhausted → stays paused; any clean run resets the budget.

## Install

```bash
pi install git:github.com/pi-dal/pi-proxy-guard
# or from a local checkout:
pi install ~/Developer/pi-proxy-guard
```

Restart pi. `/proxyguard check|restart|status` verifies it's live; logs go to `~/.pi/agent/proxy-guard.log`.

## Setup: repairing Shadowrocket on macOS

Zero-setup (verified on the Apple-Silicon iOS-app runtime): the extension runs

```sh
open -g "shadowrocket://disconnect?autoclose=true"   # tunnel drops
sleep 3
open -g "shadowrocket://connect?autoclose=true"     # fresh tunnel
```

`-g` keeps Shadowrocket in the background; `autoclose=true` lets it quit itself. If you have **always-on** enabled, the tunnel may auto-reconnect before the explicit connect — either way you end up on a fresh tunnel, which is the point (the dead stream is already dead; repair makes the *next* request land on a rebuilt chain).

### Shortcut path (optional)

`PI_PROXY_GUARD_SHORTCUT` (default name **Reconnect Shadowrocket**) runs `shortcuts run <name>` first, scheme fallback after. **Verified caveat**: on macOS, `shortcuts run` does *not* fire iOS-app SiriKit intents — a shortcut wrapping Shadowrocket's `StopVPNIntent`/`StartVPNIntent` is a silent no-op via CLI (it only fires from the Shortcuts.app GUI). So on macOS the shortcut path only helps if it wraps shell-able actions (e.g. `Run Shell Script` driving another client). Set `PI_PROXY_GUARD_SHORTCUT=""` to skip it entirely.

Node switching is intentionally left to the proxy client (chain-proxy friendly). To make the *repair* more effective, you can chain actions into the URL scheme too — e.g. `shadowrocket://select?s=<node>` before `connect` selects a different entry node.

### Verification note

`scutil --nc show/list` reports the NE manager's *intent* state and lags reality by several seconds — during a real disconnect it still says `Connected`. The extension therefore verifies repair with real HTTP probes through the proxy, never scutil.

## Tuning pi's own retries

`~/.pi/agent/settings.json` — more internal retries give the watchdog runway to repair mid-run, so fewer pauses ever happen:

```json
"retry": { "enabled": true, "maxRetries": 5, "baseDelayMs": 4000, "maxAgentDelayMs": 60000 }
```

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `PI_PROXY_GUARD` | `1` | `0` disables |
| `PI_PROXY_GUARD_URL` | `https://www.google.com/generate_204` | cheap ping (watchdog ticks) |
| `PI_PROXY_GUARD_API_URL` | `ctx.model.baseUrl` | deep-probe target; defaults to the active model's API host — any HTTP response counts as reachable |
| `PI_PROXY_GUARD_STREAM_URL` | `https://speed.cloudflare.com/__down?bytes=65536` | sustained-transfer probe used in deep checks |
| `PI_PROXY_GUARD_STREAM_MIN_BYTES` | `60000` | min bytes the transfer must deliver; `0` disables it |
| `PI_PROXY_GUARD_VPN_SERVICE` | _unset_ | `scutil --nc` service name — tunnel-down short-circuits straight to repair |
| `PI_PROXY_GUARD_PROXY` | _(env)_ | explicit `-x` proxy for the check |
| `PI_PROXY_GUARD_TIMEOUT_MS` | `20000` | per-attempt check timeout |
| `PI_PROXY_GUARD_PROBE_ATTEMPTS` | `2` | consecutive failures required to declare "down" — tolerates latency spikes without mis-firing a repair |
| `PI_PROXY_GUARD_PROBE_GAP_MS` | `1500` | gap between probe attempts |
| `PI_PROXY_GUARD_SHORTCUT` | `Reconnect Shadowrocket` | `""` disables |
| `PI_PROXY_GUARD_SCHEME` | `1` | `0` disables `shadowrocket://` fallback |
| `PI_PROXY_GUARD_ESCALATE_AFTER` | `2` | consecutive errors → repair despite OK ping |
| `PI_PROXY_GUARD_PAUSED_REPAIRS` | `3` | active repair attempts per down-episode before passive watch |
| `PI_PROXY_GUARD_NOTIFY` | `macos,bark,webhook` | channels; `0`/`off` disables |
| `PI_PROXY_GUARD_NOTIFY_RESUME` | `0` | `1` also pushes when the session resumes |
| `PI_PROXY_GUARD_NOTIFY_FINISH_MS` | `0` | `>0` pushes "Pi finished" only for clean completes lasting ≥ this long — unlike pi-bark, never fires on error settles; e.g. `120000` |
| `PI_PROXY_GUARD_NOTIFY_COOLDOWN_MS` | `600000` | min gap between pushes |
| `PI_PROXY_GUARD_BARK` | _unset_ | Bark URL incl. device key |
| `PI_PROXY_GUARD_WEBHOOK` | _unset_ | generic JSON webhook |
| `PI_PROXY_GUARD_REPAIR_COOLDOWN_MS` | `90000` | min gap between repairs |
| `PI_PROXY_GUARD_RECHECK_DELAY_MS` | `8000` | wait after repair before recheck |
| `PI_PROXY_GUARD_BACKOFF_MS` | `3000` | wait before continue on OK check |
| `PI_PROXY_GUARD_MAX_REPAIRS` | `5` | auto-continues per window |
| `PI_PROXY_GUARD_WINDOW_MS` | `600000` | budget window |
| `PI_PROXY_GUARD_WATCHDOG_MS` | `60000` | `0` disables |
| `PI_PROXY_GUARD_LOG` | `~/.pi/agent/proxy-guard.log` | `""` disables |

## Structural fix (if nodes keep flapping)

A mid-stream cut can't be undone — only prevented. If this keeps happening, put a local proxy with node failover between pi and the subscriptions: mihomo/clash `url-test` or `fallback` group → point `https_proxy` at `127.0.0.1:7890`. Pi's retries then hit a healthy node automatically and extension repairs become rare.
