# ASSURENET startup and recovery guide

## Start the platform

From Kali, run:

```bash
cd ~/telecom-assurance-lab
./start.sh
```

The launcher checks the existing Python environment and frontend dependencies, requests sudo once for network and SNMP-agent management, and keeps the collector, QoS monitor, API, and dashboard processes running as the project user (`kali`). It checks `/usr/bin/ping` for `cap_net_raw`; it changes the capability only when it is missing and verifies the result. The network namespaces are left alone when their interfaces, addresses, link state, and routes are healthy. Startup removes detected `tc netem` impairment, checks a real client-to-server ping as `kali`, starts services, waits for API/dashboard readiness, and confirms that both collectors wrote fresh rows.

Open the dashboard in Kali Firefox at <http://localhost:5173> and the API docs at <http://localhost:8000/docs>. FastAPI and Vite bind to Kali loopback when the launcher starts them. Vite proxies `/api` and `/restconf` to FastAPI, so dashboard requests use the same origin. Use `./start.sh --check` for dependency and existing web-service checks without starting or stopping services. The launcher uses a lock to prevent two copies from managing the same runtime.

## Open the dashboard from Windows

With `./start.sh` running in Kali, paste this command into Windows PowerShell:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" `
  -L 5173:127.0.0.1:5173 `
  kali@127.0.0.1 -p 2222
```

Leave that PowerShell SSH session open while using the dashboard. Open <http://localhost:5173> in Windows Chrome or Edge. The browser reaches FastAPI through Vite, so the normal dashboard does not need a separate API port forward.

For optional direct API documentation from Windows, add `-L 8001:127.0.0.1:8000` to the SSH command and open <http://localhost:8001/docs>. The dashboard does not use port 8001. The launcher prints these access instructions after startup; it does not attempt to connect to Windows.

## Stop the platform

Press **Ctrl+C** in the launcher terminal. It sends SIGTERM to the process groups it started, waits up to ten seconds for graceful exit, and only then forces any remaining groups to stop. Reused API or Vite processes are not owned by this launcher and are left running. Logs and `metrics.db` are retained.

## Restore normal network conditions

Startup automatically removes detected root `netem` qdiscs from router interfaces `r0` and `r1`. To restore manually while the launcher is not running, use this one command:

```bash
sudo ip netns exec tsa-router bash -lc 'for dev in r1 r0; do tc qdisc del dev "$dev" root 2>/dev/null || true; done'
```

“No such file or directory” means that interface did not have a root qdisc. For a degradation demo, apply impairment after startup:

```bash
sudo ip netns exec tsa-router tc qdisc add dev r1 root netem delay 100ms loss 5%
```

Then remove it using the recovery commands above. Wait for the next QoS samples to see the breach and recovery transition.

## Ping permissions and probe states

`/usr/bin/ping` needs `cap_net_raw` so the QoS monitor can run unprivileged. The launcher checks and configures this capability during privileged startup only if it is absent, then verifies it:

```bash
getcap /usr/bin/ping
```

Expected output includes `cap_net_raw=ep`. The Python monitors do not run as root. If setup fails, install `libcap2-bin` and `iputils-ping`, then retry `./start.sh`; the equivalent manual repair is `sudo setcap cap_net_raw+ep /usr/bin/ping`.

A real ping summary with zero replies is recorded as 100% packet loss. A missing executable, permission error, timeout, or other execution failure is recorded as an `UNKNOWN` QoS sample with an error reason and no fabricated packet-loss value. `UNKNOWN` samples do not open or close SLA incidents. An open incident remains open until a genuine `NORMAL` sample resolves it.

## SQLite concurrency and data retention

The QoS monitor and SNMP collector each use a 3-second SQLite busy timeout and bounded retries with exponential backoff for `BUSY`/`LOCKED` write errors. Network probes and SNMP reads happen before each short write transaction. Failed transactions roll back before retrying. The database stays in its existing journal mode; WAL is not enabled, avoiding a persistent journal-mode change while the short serialized writes and retries address the observed contention. Existing tables, measurements, and SLA events are preserved; the launcher and monitors do not clear historical records.

## Logs

Review these files when a service fails:

- `logs/snmp-agent.log`
- `logs/snmp-collector.log`
- `logs/qos-monitor.log`
- `logs/api.log`
- `logs/web.log`
- `logs/connectivity-check.log`
- `logs/model-training.log` (only when training was attempted)

## Troubleshooting

- **Ping capability error:** check `getcap /usr/bin/ping`, install `libcap2-bin` if `setcap`/`getcap` is missing, and rerun `./start.sh` in a terminal that can authenticate sudo.
- **Connectivity check fails:** the launcher will not start collectors until the client can ping `10.10.2.2`. Check routes, interface states, and `logs/connectivity-check.log`. Startup preserves partially present or misconfigured namespaces instead of deleting them; repair them before retrying.
- **No fresh measurements:** inspect both collector logs and confirm the SNMP agent is responding. Startup waits for new rows in both tables and reports an error if either collector fails to produce one.
- **SQLite lock retries exhausted:** inspect whether another process is writing to `metrics.db` or whether a long-running transaction is holding a lock. The monitor logs each bounded retry and exits visibly if the lock persists.
- **Port 8000 or 5173 conflict:** compatible existing API/dashboard processes are reused; an incompatible service on either port must be stopped before launch.
- **Launcher lock error:** another launcher owns `logs/.assurenet.lock`. Stop it with Ctrl+C before starting another copy. Do not remove the lock file while a launcher may still be running.
- **Rebuild the lab:** `setup_lab.sh` deletes and recreates the three lab namespaces. Use it only when you intentionally want to rebuild the isolated lab; it is not the normal startup path.

The early-warning score is experimental and unvalidated. It is hidden when the latest probe is stale, incomplete, `UNKNOWN`, or currently breached; it must not be used as an SLA decision.
