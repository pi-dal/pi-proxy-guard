# pi-proxy-guard

Auto-recover [pi](https://github.com/earendil-works/pi) sessions when the proxy drops mid-run.

When all provider retries fail (`Retry failed after N attempts` / `Stream ended without finish_reason`), pi pauses the session. This extension:

1. **Checks connectivity** (`curl https://www.google.com/generate_204`, inheriting the same `https_proxy` env pi uses).
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

## Setup: the Shortcuts shortcut

Default name: **Reconnect Shadowrocket** (set `PI_PROXY_GUARD_SHORTCUT` to rename). Build it in macOS Shortcuts — the user already has `Disconnect VPN` / `Connect VPN` shortcuts whose actions can be reused:

1. `Disconnect VPN` (or Shadowrocket "Stop" action)
2. Wait 2s
3. `Connect VPN` (or Shadowrocket "Start" action)
4. Wait 5s

Or, zero-setup: it falls back to `open shadowrocket://stop` → `shadowrocket://start` automatically (works when Shadowrocket registers its URL scheme — on macOS this needs the Apple Silicon iOS app).

Node switching is intentionally left to the proxy client (chain-proxy friendly). To make the *repair* more effective, build the node switch into the shortcut itself — e.g. select a different entry node inside Shadowrocket before reconnecting.

## Tuning pi's own retries

`~/.pi/agent/settings.json` — more internal retries give the watchdog runway to repair mid-run, so fewer pauses ever happen:

```json
"retry": { "enabled": true, "maxRetries": 5, "baseDelayMs": 4000, "maxAgentDelayMs": 60000 }
```

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `PI_PROXY_GUARD` | `1` | `0` disables |
| `PI_PROXY_GUARD_URL` | `https://www.google.com/generate_204` | health-check target; for tighter signal use your provider's API URL |
| `PI_PROXY_GUARD_PROXY` | _(env)_ | explicit `-x` proxy for the check |
| `PI_PROXY_GUARD_TIMEOUT_MS` | `10000` | check timeout |
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
