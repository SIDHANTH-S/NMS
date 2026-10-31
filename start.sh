#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$ROOT_DIR/web"
VENV_PYTHON="$ROOT_DIR/venv/bin/python"
LOG_DIR="$ROOT_DIR/logs"
declare -a SERVICE_NAMES=()
declare -a SERVICE_PIDS=()
declare -a SERVICE_LOGS=()
STOPPING=0
API_REUSED=0
WEB_REUSED=0
RUN_USER=""

say() { printf '[assurenet] %s\n' "$*"; }
fail() { say "ERROR: $*" >&2; exit 1; }

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' is missing. Install it, then run ./start.sh again."
}

check_prerequisites() {
    for command_name in sudo ip ss setsid runuser snmpd ping curl node npm; do
        require_command "$command_name"
    done
    [[ -x "$VENV_PYTHON" ]] || fail "Project virtual environment is missing. Create it and install requirements.txt first."
    "$VENV_PYTHON" -c 'import fastapi, uvicorn, sklearn' >/dev/null 2>&1 \
        || fail "Python dependencies are missing. Run: source venv/bin/activate && pip install -r requirements.txt"
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)' \
        || fail "Node.js 20.19 or newer is required by this Vite project."
    [[ -f "$WEB_DIR/package-lock.json" ]] || fail "Frontend lockfile is missing: $WEB_DIR/package-lock.json"
}

detect_existing_services() {
    if ss -H -ltn 'sport = :8000' | grep -q .; then
        if curl --fail --silent http://127.0.0.1:8000/api/v1/system >/dev/null \
            && curl --fail --silent http://127.0.0.1:8000/api/v1/prediction/early-warning >/dev/null; then
            API_REUSED=1
            say "A compatible FastAPI instance is already healthy on port 8000; reusing it."
        else
            fail "Port 8000 is occupied by a service that is not this project's current API. Stop it before launching."
        fi
    fi

    if ss -H -ltn 'sport = :5173' | grep -q .; then
        if curl --fail --silent http://127.0.0.1:5173/ | grep -q '<div id="root"></div>'; then
            WEB_REUSED=1
            say "A dashboard is already healthy on port 5173; reusing it."
        else
            fail "Port 5173 is occupied by a service that is not this project's Vite dashboard. Stop it before launching."
        fi
    fi
}

namespace_ready() {
    local namespace="$1" interface="$2"
    ip netns list | awk '{print $1}' | grep -Fxq "$namespace" \
        && ip -n "$namespace" link show dev "$interface" >/dev/null 2>&1
}

ensure_lab() {
    local ready=1
    namespace_ready tsa-client c0 || ready=0
    namespace_ready tsa-router r0 || ready=0
    namespace_ready tsa-router r1 || ready=0
    namespace_ready tsa-server s0 || ready=0

    if (( ready )); then
        say "Network namespaces and expected interfaces are present; leaving them in place."
    else
        say "Network lab is incomplete. Recreating namespaces with setup_lab.sh..."
        bash "$ROOT_DIR/setup_lab.sh"
    fi
}

start_service() {
    local name="$1" log_file="$2"
    shift 2
    setsid "$@" >>"$LOG_DIR/$log_file" 2>&1 &
    local pid=$!
    SERVICE_NAMES+=("$name")
    SERVICE_PIDS+=("$pid")
    SERVICE_LOGS+=("$log_file")
    sleep 0.3
    if ! kill -0 "$pid" 2>/dev/null; then
        tail -n 30 "$LOG_DIR/$log_file" >&2 || true
        fail "$name exited during startup. See $LOG_DIR/$log_file"
    fi
    chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$LOG_DIR/$log_file"
    say "$name started (PID $pid; log: logs/$log_file)."
}

wait_for_url() {
    local name="$1" url="$2" attempt
    for attempt in {1..30}; do
        if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
            say "$name is responding at $url."
            return 0
        fi
        sleep 1
        assert_services_alive
    done
    fail "$name did not become ready at $url. Check its log under logs/."
}

assert_services_alive() {
    local index pid
    for index in "${!SERVICE_PIDS[@]}"; do
        pid="${SERVICE_PIDS[$index]}"
        if ! kill -0 "$pid" 2>/dev/null; then
            tail -n 30 "$LOG_DIR/${SERVICE_LOGS[$index]}" >&2 || true
            fail "${SERVICE_NAMES[$index]} stopped unexpectedly. Check logs/${SERVICE_LOGS[$index]}."
        fi
    done
}

cleanup() {
    local status=$?
    (( STOPPING )) && return "$status"
    STOPPING=1
    trap - EXIT INT TERM
    if ((${#SERVICE_PIDS[@]})); then
        say "Stopping services started by this launcher..."
        local index pid
        for ((index=${#SERVICE_PIDS[@]}-1; index>=0; index--)); do
            pid="${SERVICE_PIDS[$index]}"
            kill -TERM -- "-$pid" 2>/dev/null || true
        done
        sleep 1
        for ((index=${#SERVICE_PIDS[@]}-1; index>=0; index--)); do
            pid="${SERVICE_PIDS[$index]}"
            kill -KILL -- "-$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            say "${SERVICE_NAMES[$index]} stopped."
        done
    fi
    exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$ROOT_DIR"
check_prerequisites
detect_existing_services
if [[ "${1:-}" == "--check" ]]; then
    say "Prerequisite and service checks passed; no services were started or stopped."
    exit 0
fi

if [[ ! -d "$WEB_DIR/node_modules" ]]; then
    say "Installing locked frontend dependencies with npm ci..."
    (cd "$WEB_DIR" && npm ci)
fi

if [[ "${1:-}" != "--root-mode" && "$EUID" -ne 0 ]]; then
    say "Authenticating sudo in this terminal before starting privileged network services..."
    sudo -v
    exec sudo -E bash "$ROOT_DIR/start.sh" --root-mode
fi

RUN_USER="${SUDO_USER:-$(stat -c '%U' "$ROOT_DIR")}"
id "$RUN_USER" >/dev/null 2>&1 || fail "Could not identify the project user for application services."

mkdir -p "$LOG_DIR"
chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$LOG_DIR"
if [[ ! -f "$ROOT_DIR/qos_risk_model.joblib" ]]; then
    say "No trained QoS model found. Attempting training from existing history..."
    if runuser -u "$RUN_USER" -- "$VENV_PYTHON" "$ROOT_DIR/train_qos_model.py" >"$LOG_DIR/model-training.log" 2>&1; then
        say "Experimental QoS model trained from existing history."
    else
        say "WARNING: Existing history is not sufficient for model training yet; the dashboard will show the model as unavailable. See logs/model-training.log."
    fi
    chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$LOG_DIR/model-training.log"
fi

say "Starting network services with elevated access; application services will run as $RUN_USER."
ensure_lab

start_service "SNMP agent" "snmp-agent.log" ip netns exec tsa-router \
    snmpd -f -Lo -C -c "$ROOT_DIR/snmpd.conf"
sleep 1
assert_services_alive

start_service "SNMP collector" "snmp-collector.log" ip netns exec tsa-client runuser -u "$RUN_USER" -- \
    "$VENV_PYTHON" "$ROOT_DIR/snmp_collector.py"
start_service "QoS monitor" "qos-monitor.log" ip netns exec tsa-client runuser -u "$RUN_USER" -- \
    "$VENV_PYTHON" "$ROOT_DIR/qos_monitor.py"
if (( ! API_REUSED )); then
    start_service "FastAPI" "api.log" runuser -u "$RUN_USER" -- "$VENV_PYTHON" -m uvicorn api:app \
        --host 0.0.0.0 --port 8000
fi
if (( ! WEB_REUSED )); then
    start_service "React/Vite dashboard" "web.log" runuser -u "$RUN_USER" -- npm --prefix "$WEB_DIR" run dev -- --host 0.0.0.0 --port 5173
fi

wait_for_url "FastAPI" "http://127.0.0.1:8000/api/v1/system"
wait_for_url "React/Vite dashboard" "http://127.0.0.1:5173/"
say "All services are running. Dashboard: http://127.0.0.1:5173  API docs: http://127.0.0.1:8000/docs"
say "Press Ctrl+C to stop all services started by this script."

while true; do
    sleep 15 &
    wait $! || true
    assert_services_alive
    for index in "${!SERVICE_NAMES[@]}"; do
        say "${SERVICE_NAMES[$index]}: running (PID ${SERVICE_PIDS[$index]})."
    done
    (( API_REUSED )) && say "FastAPI: running (reused; not owned by this launcher)."
    (( WEB_REUSED )) && say "React/Vite dashboard: running (reused; not owned by this launcher)."
done
