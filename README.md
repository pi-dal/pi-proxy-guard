# pi-proxy-guard

A [Pi](https://github.com/earendil-works/pi) extension that recovers **network-failed** sessions without treating every provider error as a broken proxy. It does not own sakamoto's VPN or node selector.

## What happens on an error

| Evidence | Action |
|---|---|
| Quota, authentication, permission, or unknown error | Stay paused. Never change the proxy or automatically repeat a provider request. |
| Classified network/stream error; deep Pi path works twice | Continue once after a short backoff. |
| Repeated deep Pi-path failure; sakamoto **observe** mode (default) | Stay paused while sakamoto's independent watcher works. Deep-check again later; never restart or select a node. |
| Repeated deep failure; sakamoto **recover** mode | Wait for sakamoto's next watcher interval (default 45s), then require two fresh deep successes before continuing. If still down, stay paused and notify. |
| Sakamoto supervisor deliberately disconnected | Do not start the VPN. Stay paused until the user connects it. |

A deep check queries the active model API host for transport reachability and downloads at least 60 KB from an independent endpoint. A cheap 204 probe alone cannot resume a paused session. Three consecutive failed attempts (default) avoid switching because of one latency spike. A verified recovery must pass **two** sustained-transfer checks. Provider-request budgets, repair cooldowns and passive monitoring remain in force.

**Selector ownership:** sakamoto already URL-tests `RealityAuto` and `OthersAuto` and may switch `MainProxy` when its own evidence says one group failed. `ManualPick` remains manual. This extension never writes the selector, reads the sing-box API key, bypasses a chained SOCKS exit, or restarts the TUN. A SOCKS-exit failure may leave both entry groups healthy; node switching cannot reliably solve that case and the session remains paused for diagnosis.

## Install and start safely

```bash
pi install git:github.com/pi-dal/pi-proxy-guard@v0.7.0
# Or load a checkout locally for testing:
pi install ~/Developer/pi-proxy-guard
```

Restart or reload Pi **while idle**. `/proxyguard check`, `/proxyguard status`, and `/proxyguard recover` inspect the guard. It does not migrate an existing sakamoto daemon or turn on the VPN. The default `PI_PROXY_GUARD_BACKEND=auto` uses sakamoto only if its private local supervisor socket is present; otherwise it does not launch any VPN. It never falls back to Shadowrocket implicitly.

Begin with observe-only behavior (the default) and inspect `~/.pi/agent/proxy-guard.log`. Once the Pi provider path and sakamoto's watcher have been verified together, opt into waiting for automatic watcher recovery:

```bash
export PI_PROXY_GUARD_BACKEND=sakamoto
export PI_PROXY_GUARD_SAKAMOTO_MODE=recover
```

If Pi explicitly uses sakamoto's local mixed proxy, its health checks should use **that same proxy path**. `curl` otherwise inherits the process HTTP(S) proxy environment, which may not match Pi's transport in every setup. Set `PI_PROXY_GUARD_PROXY` only after checking Pi's own proxy setting and your actual mixed-inbound port. `curl --noproxy '*'` bypasses an HTTP proxy, **not** a macOS TUN; it is not a proof of direct internet access.

The guard trusts sakamoto's watcher to switch only on fresh URL tests. Its tests check entry nodes, not necessarily the chained SOCKS exit. In recover mode it waits, verifies the **Pi path**, and leaves a failed session paused rather than cycling nodes or retrying the provider indefinitely. A mid-stream cut cannot be undone; a healthy route lets Pi's next request succeed.

## Legacy Shadowrocket backend (explicit opt-in)

`PI_PROXY_GUARD_BACKEND=shadowrocket` retains the old shortcut-first and `shadowrocket://` fallback. **Do not enable it while sakamoto TUN is active:** two VPNs can conflict and sakamoto's supervisor will stop its TUN. `PI_PROXY_GUARD_SHORTCUT=""` disables Shortcuts; `PI_PROXY_GUARD_SCHEME=0` disables URL-scheme repair. The macOS CLI cannot invoke iOS-app SiriKit VPN intents through `shortcuts run`; only shell-capable Shortcuts are useful.

## Notifications

`PI_PROXY_GUARD_NOTIFY="macos,bark,webhook"` enables configured channels (default); `0` disables all. Bark and webhook URLs are secrets—never add them to git or logs. The guard creates its own diagnostic log with mode `0600` and redacts credentials from status and command errors. A Bark URL can be supplied as `PI_PROXY_GUARD_BARK`; a JSON webhook uses `PI_PROXY_GUARD_WEBHOOK`. Notifications are throttled by `PI_PROXY_GUARD_NOTIFY_COOLDOWN_MS`. Curl's `--noproxy '*'` bypasses the HTTP proxy for notifications but **does not bypass TUN routing**, so delivery during a full network outage is not guaranteed.

`PI_PROXY_GUARD_NOTIFY_FINISH_MS=120000` enables a duration-gated "Pi finished" message only when the Pi run actually completed and went idle; failed settles are not sent as successful completions. `PI_PROXY_GUARD_NOTIFY_RESUME=1` also announces recovery.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_PROXY_GUARD` | `1` | `0` disables the extension. |
| `PI_PROXY_GUARD_BACKEND` | `auto` | `auto` finds sakamoto's local supervisor; `sakamoto` requires it; `shadowrocket` explicitly enables legacy repair; `none` never repairs. |
| `PI_PROXY_GUARD_SAKAMOTO_MODE` | `observe` | `recover` waits for watcher-owned fallback, without selector or VPN writes. |
| `PI_PROXY_GUARD_SAKAMOTO_WAIT_MS` | `45000` | Wait for sakamoto's URL-test and settle cycle. |
| `PI_PROXY_GUARD_URL` | `https://www.google.com/generate_204` | Cheap watchdog probe; requires HTTP 2xx. |
| `PI_PROXY_GUARD_API_URL` | current model base URL | API host for a deep transport check; 5xx is not a successful path. |
| `PI_PROXY_GUARD_STREAM_URL` | Cloudflare 64 KB download | Sustained-transfer target; must return 2xx and enough bytes. |
| `PI_PROXY_GUARD_STREAM_MIN_BYTES` | `60000` | Minimum successful bytes; `0` disables transfer verification (less safe). |
| `PI_PROXY_GUARD_PROXY` | process proxy environment | Optional explicit curl proxy; use Pi's actual path. |
| `PI_PROXY_GUARD_TIMEOUT_MS` | `20000` | Timeout for one probe attempt. |
| `PI_PROXY_GUARD_PROBE_ATTEMPTS` | `3` | Consecutive failures required to conclude that a path is down. |
| `PI_PROXY_GUARD_PROBE_GAP_MS` | `1500` | Delay between attempts and independent recovery checks. |
| `PI_PROXY_GUARD_PAUSED_REPAIRS` | `3` | Maximum active waits/repairs in one outage episode. |
| `PI_PROXY_GUARD_REPAIR_COOLDOWN_MS` | `90000` | Minimum gap between recovery attempts. |
| `PI_PROXY_GUARD_WATCHDOG_MS` | `60000` | Watch an active or paused run; `0` disables it. |
| `PI_PROXY_GUARD_MAX_REPAIRS` / `PI_PROXY_GUARD_WINDOW_MS` | `5` / `600000` | Rolling provider auto-continue budget. |
| `PI_PROXY_GUARD_BACKOFF_MS` / `PI_PROXY_GUARD_RECHECK_DELAY_MS` | `3000` / `8000` | Delays for continuation/explicit legacy repair. |
| `PI_PROXY_GUARD_VPN_SERVICE` | unset | Optional `scutil --nc` service used **only** for the explicit Shadowrocket backend. |
| `PI_PROXY_GUARD_SHORTCUT` / `PI_PROXY_GUARD_SCHEME` | `Reconnect Shadowrocket` / `1` | **Legacy backend only**. Neither runs under sakamoto/none. |
| `PI_PROXY_GUARD_NOTIFY` / `PI_PROXY_GUARD_NOTIFY_RESUME` | `macos,bark,webhook` / `0` | Notification channels and optional resume push. |
| `PI_PROXY_GUARD_NOTIFY_FINISH_MS` / `PI_PROXY_GUARD_NOTIFY_COOLDOWN_MS` | `0` / `600000` | Completion threshold and push throttle. |
| `PI_PROXY_GUARD_LOG` | `~/.pi/agent/proxy-guard.log` | Empty string disables the diagnostic log. |

For emergency rollback set `PI_PROXY_GUARD=0` and reload Pi when idle; this does not touch sakamoto or its running VPN. The extension neither exposes nor prints the sakamoto API secret.
