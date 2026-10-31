# Telecom assurance API

## Single-command lab launcher

From the project directory, run:

```bash
cd ~/telecom-assurance-lab
./start.sh
```

The launcher checks prerequisites and the existing namespaces, creates the network lab only when it is incomplete, then starts the SNMP agent, collectors, API, and dashboard. It keeps running and reports each service's status. Press Ctrl+C to stop the processes started by that launcher. Per-service output is saved under `logs/`.

The launcher requires `sudo` for network namespaces and the SNMP agent, Node.js 20.19 or newer with npm, the project `venv`, and installed Python dependencies. It asks for sudo authentication in the current terminal, then restarts its supervisor with elevated access so background SNMP work can start without trying to prompt from a detached process. Collectors, API, and dashboard run as the normal project user. It installs locked frontend packages with `npm ci` on the first run when `web/node_modules` is absent. If no model artifact exists, it attempts training from the current database; with too little data, all other services still start and the UI reports the model as unavailable. Healthy instances of this project's API and dashboard are reused; an unrelated service using either port produces a clear error.

Use `./start.sh --check` to validate dependencies and detect compatible API/dashboard instances without starting or stopping services. If compatible instances are already running, `./start.sh` reuses them and only cleans up processes it started when you press Ctrl+C.

`api.py` serves read-only endpoints backed by the existing `metrics.db` in this directory. It opens SQLite with `mode=ro`, does not create tables, and does not change historical rows. It expects the existing `metrics`, `qos_metrics`, and `sla_events` tables.

The `/restconf/data/telecom:*` paths use RESTCONF-compatible resource naming and YANG-inspired JSON. They are not a claim of full RFC 8040 compliance.

## Install and start

From `~/telecom-assurance-lab` on Kali:

```bash
source venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn api:app --host 0.0.0.0 --port 8000
```

The API binds to all Kali interfaces so a dashboard or host browser can reach it. If you only need access inside Kali, use `--host 127.0.0.1` instead. The database path is anchored to the location of `api.py`, independent of the current working directory.

## Endpoints

- `GET /api/v1/system` — API/database availability, latest QoS and traffic timestamps, and the latest open SLA event.
- `GET /api/v1/qos/latest` — latest QoS row, or `{"data": null}` when empty.
- `GET /api/v1/qos/history?limit=100` — newest QoS samples for latency and packet-loss charts. `limit` is 1–1000.
- `GET /api/v1/prediction/early-warning` — experimental model score for an SLA breach within the next three QoS samples. Returns `available: false` until the model has been trained.
- `GET /api/v1/metrics/history?limit=100&interface=r1` — newest traffic rows. `limit` is 1–1000; `interface` is optional.
- `GET /api/v1/sla/events?limit=100&status=OPEN` — newest incident rows. `limit` is 1–1000; `status` is optional.
- `GET /restconf/data/telecom:interfaces` — latest traffic row for each interface in a YANG-inspired wrapper.
- `GET /restconf/data/telecom:services` — latest QoS and any open SLA event in a service wrapper.

Empty lists return `data: []`; missing latest measurements return `data: null`. The API permits GET/OPTIONS from React development origins on localhost ports 3000 and 5173. Add the exact origin to `allow_origins` in `api.py` if the dev server uses another port or hostname.

## Verify

With the server running in one terminal, run these in another terminal on Kali:

```bash
curl -i http://127.0.0.1:8000/api/v1/system
curl -i http://127.0.0.1:8000/api/v1/qos/latest
curl -i 'http://127.0.0.1:8000/api/v1/qos/history?limit=5'
curl -i 'http://127.0.0.1:8000/api/v1/metrics/history?limit=5'
curl -i 'http://127.0.0.1:8000/api/v1/sla/events?limit=5'
curl -i http://127.0.0.1:8000/restconf/data/telecom:interfaces
curl -i http://127.0.0.1:8000/restconf/data/telecom:services
```

OpenAPI docs are available at `http://127.0.0.1:8000/docs` while the server runs.

## Experimental QoS early warning

The prediction model uses rolling latency/loss features plus recent r0/r1 SNMP rates. Its label is a breach in any of the next three QoS samples. Train it from the existing history without changing the database:

```bash
cd ~/telecom-assurance-lab
source venv/bin/activate
python train_qos_model.py
```

The script reports a chronological 80/20 holdout and writes an ignored model artifact. The score is experimental and uncalibrated; the model report identifies when the time-ordered holdout has no breach examples. Collect more normal and impaired scenarios before treating its score as an operational warning.
