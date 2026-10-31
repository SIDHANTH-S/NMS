#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$ROOT_DIR/web"
VENV_PYTHON="$ROOT_DIR/venv/bin/python"
LOG_DIR="$ROOT_DIR/logs"
RUNTIME_PID_FILE="$LOG_DIR/.assurenet-start.pid"
declare -a SERVICE_NAMES=() SERVICE_PIDS=() SERVICE_LOGS=()
STOPPING=0 API_REUSED=0 WEB_REUSED=0 RUN_USER=""

say() { printf '[assurenet] %s\n' "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' is missing. Install it, then run ./start.sh again."; }

check_prerequisites() {
    for cmd in sudo ip ss setsid runuser snmpd ping curl node npm getcap setcap flock tc; do require_command "$cmd"; done
    [[ -x "$VENV_PYTHON" ]] || fail "Project virtual environment is missing. Create it and install requirements.txt first."
    "$VENV_PYTHON" -c 'import fastapi, uvicorn, sklearn, pysnmp' >/dev/null 2>&1 || fail "Python dependencies are missing. Run: source venv/bin/activate && pip install -r requirements.txt"
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)' || fail "Node.js 20.19 or newer is required by this Vite project."
    [[ -f "$WEB_DIR/package-lock.json" ]] || fail "Frontend lockfile is missing: $WEB_DIR/package-lock.json"
}

detect_existing_services() {
    if ss -H -ltn 'sport = :8000' | grep -q .; then
        if curl --fail --silent http://127.0.0.1:8000/api/v1/system >/dev/null && curl --fail --silent http://127.0.0.1:8000/api/v1/prediction/early-warning >/dev/null; then
            API_REUSED=1; say "A compatible FastAPI instance is already healthy on port 8000; reusing it."
        else fail "Port 8000 is occupied by a service that is not this project's API."; fi
    fi
    if ss -H -ltn 'sport = :5173' | grep -q .; then
        if curl --fail --silent http://127.0.0.1:5173/ | grep -q '<div id="root"></div>'; then
            WEB_REUSED=1; say "A dashboard is already healthy on port 5173; reusing it."
        else fail "Port 5173 is occupied by a service that is not this project's Vite dashboard."; fi
    fi
}

interface_ready() {
    local ns="$1" dev="$2" addr="$3"
    ip netns exec "$ns" ip -o link show dev "$dev" 2>/dev/null | grep -q 'state UP' \
      && ip -n "$ns" -o addr show dev "$dev" 2>/dev/null | grep -Fq "$addr"
}

namespace_ready() {
    ip netns list | awk '{print $1}' | grep -Fxq tsa-client \
      && ip netns list | awk '{print $1}' | grep -Fxq tsa-router \
      && ip netns list | awk '{print $1}' | grep -Fxq tsa-server \
      && interface_ready tsa-client c0 10.10.1.2/24 \
      && interface_ready tsa-router r0 10.10.1.1/24 \
      && interface_ready tsa-router r1 10.10.2.1/24 \
      && interface_ready tsa-server s0 10.10.2.2/24 \
      && ip -n tsa-client route show default | grep -q 'via 10.10.1.1' \
      && ip -n tsa-server route show default | grep -q 'via 10.10.2.1'
}

ensure_lab() {
    if namespace_ready; then say "Network namespaces, interface addresses, link state, and routes are healthy; leaving them in place."
    else
        local existing=0 ns
        for ns in tsa-client tsa-router tsa-server; do
            ip netns list | awk '{print $1}' | grep -Fxq "$ns" && ((existing+=1)) || true
        done
        if (( existing > 0 )); then
            fail "The network lab is partially present or misconfigured. Existing namespaces were preserved. Repair the lab configuration, then rerun ./start.sh."
        fi
        say "No lab namespaces exist. Creating the network lab with setup_lab.sh..."
        bash "$ROOT_DIR/setup_lab.sh"
        namespace_ready || fail "Network lab setup finished, but namespace/interface verification failed."
    fi
}

ensure_ping_capability() {
    local ping_bin=/usr/bin/ping
    [[ -x "$ping_bin" ]] || fail "$ping_bin is missing or not executable. Install iputils-ping."
    if ! getcap "$ping_bin" 2>/dev/null | grep -Eq 'cap_net_raw(\+|=).*ep'; then
        say "Configuring cap_net_raw on $ping_bin for unprivileged QoS probes..."
        setcap cap_net_raw+ep "$ping_bin" || fail "Could not configure ping's cap_net_raw capability. Install libcap2-bin and run sudo setcap cap_net_raw+ep $ping_bin."
    fi
    getcap "$ping_bin" 2>/dev/null | grep -Eq 'cap_net_raw(\+|=).*ep' || fail "Ping capability verification failed for $ping_bin."
    say "Ping capability verified; monitoring applications will run as $RUN_USER."
}

clear_netem() {
    local dev qdisc
    for dev in r0 r1; do
        qdisc="$(ip netns exec tsa-router tc qdisc show dev "$dev" 2>/dev/null || true)"
        if grep -q netem <<<"$qdisc"; then
            say "Removing leftover tc netem impairment from router interface $dev."
            ip netns exec tsa-router tc qdisc del dev "$dev" root || fail "Could not clear netem impairment on $dev."
        fi
    done
}

verify_connectivity() {
    say "Verifying client-to-server connectivity using ping as $RUN_USER..."
    if ! ip netns exec tsa-client runuser -u "$RUN_USER" -- /usr/bin/ping -n -c 2 -W 2 10.10.2.2 >"$LOG_DIR/connectivity-check.log" 2>&1; then
        tail -n 15 "$LOG_DIR/connectivity-check.log" >&2 || true
        fail "Client-to-server connectivity failed. No collectors were started; inspect namespace routes, SNMP logs, and logs/connectivity-check.log."
    fi
    chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$LOG_DIR/connectivity-check.log"
    say "Client-to-server connectivity verified."
}

start_service() {
    local name="$1" log_file="$2"; shift 2
    setsid "$@" >>"$LOG_DIR/$log_file" 2>&1 &
    local pid=$!
    SERVICE_NAMES+=("$name"); SERVICE_PIDS+=("$pid"); SERVICE_LOGS+=("$log_file")
    sleep 0.3
    if ! kill -0 "$pid" 2>/dev/null; then tail -n 30 "$LOG_DIR/$log_file" >&2 || true; fail "$name exited during startup. See $LOG_DIR/$log_file"; fi
    chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$LOG_DIR/$log_file"
    say "$name started (PID $pid; log: logs/$log_file)."
}

assert_services_alive() {
    local i pid
    for i in "${!SERVICE_PIDS[@]}"; do
        pid="${SERVICE_PIDS[$i]}"
        if ! kill -0 "$pid" 2>/dev/null; then tail -n 30 "$LOG_DIR/${SERVICE_LOGS[$i]}" >&2 || true; fail "${SERVICE_NAMES[$i]} stopped unexpectedly. Check logs/${SERVICE_LOGS[$i]}."; fi
    done
}

wait_for_url() {
    local name="$1" url="$2" attempt
    for attempt in {1..30}; do
        if curl --fail --silent "$url" >/dev/null 2>&1; then say "$name is responding at $url."; return 0; fi
        sleep 1; assert_services_alive
    done
    fail "$name did not become ready at $url. Check its log under logs/."
}

print_windows_access() {
    say "Kali-local dashboard: http://localhost:5173"
    say "Windows PowerShell tunnel command (keep this SSH window open):"
    printf '%s\n' 'ssh -i "$env:USERPROFILE\.ssh\id_ed25519" `' \
        '  -L 5173:127.0.0.1:5173 `' \
        '  kali@127.0.0.1 -p 2222'
    say "Windows dashboard: http://localhost:5173"
    say "The dashboard sends API requests through Vite; no Windows API tunnel is needed."
    say "Optional direct API docs: add -L 8001:127.0.0.1:8000 to the SSH command, then open http://localhost:8001/docs."
}

wait_for_fresh_records() {
    local old_qos="$1" old_metrics="$2" attempt counts
    for attempt in {1..25}; do
        counts="$("$VENV_PYTHON" - "$ROOT_DIR/metrics.db" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=2)
try:
    print(*[conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ("qos_metrics", "metrics")])
finally:
    conn.close()
PY
        )" || fail "Could not read metrics.db while waiting for fresh samples."
        read -r qos_count metric_count <<<"$counts"
        if (( qos_count > old_qos && metric_count > old_metrics )); then say "Fresh QoS and SNMP measurements were written to metrics.db."; return 0; fi
        sleep 1; assert_services_alive
    done
    fail "Collectors stayed running but did not both write fresh records. Check logs/snmp-collector.log and logs/qos-monitor.log."
}

cleanup() {
    local status=$? i pid attempt any_alive
    (( STOPPING )) && return "$status"
    STOPPING=1; trap - EXIT INT TERM
    if ((${#SERVICE_PIDS[@]})); then
        say "Stopping services started by this launcher..."
        for ((i=${#SERVICE_PIDS[@]}-1; i>=0; i--)); do kill -TERM -- "-${SERVICE_PIDS[$i]}" 2>/dev/null || true; done
        for attempt in {1..10}; do
            any_alive=0
            for pid in "${SERVICE_PIDS[@]}"; do kill -0 -- "-$pid" 2>/dev/null && any_alive=1; done
            (( any_alive )) || break
            sleep 1
        done
        if (( any_alive )); then
            say "Some services did not exit after SIGTERM; forcing remaining process groups to stop."
            for ((i=${#SERVICE_PIDS[@]}-1; i>=0; i--)); do kill -KILL -- "-${SERVICE_PIDS[$i]}" 2>/dev/null || true; done
        fi
        for ((i=${#SERVICE_PIDS[@]}-1; i>=0; i--)); do wait "${SERVICE_PIDS[$i]}" 2>/dev/null || true; say "${SERVICE_NAMES[$i]} stopped."; done
    fi
    if [[ -f "$RUNTIME_PID_FILE" ]] && [[ "$(cat "$RUNTIME_PID_FILE" 2>/dev/null || true)" == "$$" ]]; then rm -f -- "$RUNTIME_PID_FILE"; fi
    exit "$status"
}

cd "$ROOT_DIR"
check_prerequisites
detect_existing_services
if [[ "${1:-}" == "--check" ]]; then say "Prerequisite and service checks passed; no services were started or stopped."; exit 0; fi
if [[ ! -d "$WEB_DIR/node_modules" ]]; then say "Installing locked frontend dependencies with npm ci..."; (cd "$WEB_DIR" && npm ci); fi

if [[ "${1:-}" != "--root-mode" && "$EUID" -ne 0 ]]; then
    say "Authenticating sudo in this terminal before privileged network management..."
    sudo -v
    exec sudo -E bash "$ROOT_DIR/start.sh" --root-mode
fi

RUN_USER="${SUDO_USER:-$(stat -c '%U' "$ROOT_DIR")}"
id "$RUN_USER" >/dev/null 2>&1 || fail "Could not identify the project user for application services."
mkdir -p "$LOG_DIR"
chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$LOG_DIR"
exec 9>"$LOG_DIR/.assurenet.lock"
flock -n 9 || fail "Another ASSURENET launcher already holds the runtime lock. Stop that launcher before starting another instance."
printf '%s\n' "$$" >"$RUNTIME_PID_FILE"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ensure_ping_capability
old_counts="$("$VENV_PYTHON" - "$ROOT_DIR/metrics.db" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=2)
try:
    print(*[conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ("qos_metrics", "metrics")])
finally:
    conn.close()
PY
)" || fail "Could not read the existing database counts."
read -r old_qos old_metrics <<<"$old_counts"

if [[ ! -f "$ROOT_DIR/qos_risk_model.joblib" ]]; then
    say "No trained QoS model found. Attempting training from existing history..."
    if runuser -u "$RUN_USER" -- "$VENV_PYTHON" "$ROOT_DIR/train_qos_model.py" >"$LOG_DIR/model-training.log" 2>&1; then say "Experimental QoS model trained from existing history."
    else say "WARNING: Existing history is not sufficient for training; AI score will be unavailable. See logs/model-training.log."; fi
    chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$LOG_DIR/model-training.log"
fi

say "Starting network services with elevated access; application processes will run as $RUN_USER."
ensure_lab
clear_netem
verify_connectivity

start_service "SNMP agent" "snmp-agent.log" ip netns exec tsa-router snmpd -f -Lo -C -c "$ROOT_DIR/snmpd.conf"
sleep 1; assert_services_alive
start_service "SNMP collector" "snmp-collector.log" ip netns exec tsa-client runuser -u "$RUN_USER" -- "$VENV_PYTHON" "$ROOT_DIR/snmp_collector.py"
start_service "QoS monitor" "qos-monitor.log" ip netns exec tsa-client runuser -u "$RUN_USER" -- "$VENV_PYTHON" "$ROOT_DIR/qos_monitor.py"
(( API_REUSED )) || start_service "FastAPI" "api.log" runuser -u "$RUN_USER" -- "$VENV_PYTHON" -m uvicorn api:app --host 127.0.0.1 --port 8000
(( WEB_REUSED )) || start_service "React/Vite dashboard" "web.log" runuser -u "$RUN_USER" -- npm --prefix "$WEB_DIR" run dev -- --host 127.0.0.1 --port 5173

wait_for_url "FastAPI" "http://127.0.0.1:8000/api/v1/system"
wait_for_url "React/Vite dashboard" "http://127.0.0.1:5173/"
wait_for_fresh_records "$old_qos" "$old_metrics"
say "All services are running. Kali API docs: http://localhost:8000/docs"
print_windows_access
say "Press Ctrl+C to stop all services started by this script."
for i in "${!SERVICE_NAMES[@]}"; do say "${SERVICE_NAMES[$i]}: running (PID ${SERVICE_PIDS[$i]})."; done
(( API_REUSED )) && say "FastAPI: running (reused; not owned by this launcher)."
(( WEB_REUSED )) && say "React/Vite dashboard: running (reused; not owned by this launcher)."

while true; do sleep 15 & wait $! || true; assert_services_alive; done
