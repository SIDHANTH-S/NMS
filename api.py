"""Read-only API for the telecom assurance lab's existing SQLite database."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from predictor import predict_latest


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "metrics.db"
DEFAULT_LIMIT = 100
MAX_LIMIT = 1000

app = FastAPI(
    title="Telecom Service Assurance API",
    version="1.0.0",
    description=(
        "Read-only API for the telecom assurance lab. The /restconf paths "
        "use RESTCONF-compatible resource naming and YANG-inspired JSON; "
        "this service does not claim full RFC 8040 compliance."
    ),
)

# React development servers commonly use either port 3000 or 5173.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


def _connect() -> sqlite3.Connection:
    """Open the database in read-only mode; never initialize or mutate it."""
    if not DB_PATH.is_file():
        raise HTTPException(status_code=503, detail="metrics.db was not found")
    try:
        conn = sqlite3.connect(
            f"file:{DB_PATH.as_posix()}?mode=ro",
            uri=True,
            timeout=5.0,
        )
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="Unable to read metrics.db") from exc


def _one(sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    try:
        with closing(_connect()) as conn:
            row = conn.execute(sql, params).fetchone()
            return dict(row) if row is not None else None
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail="Database query failed") from exc


def _many(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    try:
        with closing(_connect()) as conn:
            return [dict(row) for row in conn.execute(sql, params).fetchall()]
    except sqlite3.Error as exc:
        raise HTTPException(status_code=500, detail="Database query failed") from exc


@app.get("/api/v1/system")
def system_status() -> dict[str, Any]:
    qos = _one(
        "SELECT timestamp, target_ip, sla_status FROM qos_metrics ORDER BY id DESC LIMIT 1"
    )
    traffic = _one(
        "SELECT timestamp, interface FROM metrics ORDER BY id DESC LIMIT 1"
    )
    open_event = _one(
        "SELECT id, started_at, severity, reason FROM sla_events "
        "WHERE status = ? ORDER BY id DESC LIMIT 1",
        ("OPEN",),
    )
    return {
        "status": "ok",
        "database": "available",
        "latest_qos": qos,
        "latest_traffic": traffic,
        "open_sla_event": open_event,
    }


@app.get("/api/v1/qos/latest")
def qos_latest() -> dict[str, Any]:
    return {"data": _one("SELECT * FROM qos_metrics ORDER BY id DESC LIMIT 1")}


@app.get("/api/v1/qos/history")
def qos_history(
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
) -> dict[str, Any]:
    """Return recent QoS samples for latency and packet-loss charts."""
    rows = _many("SELECT * FROM qos_metrics ORDER BY id DESC LIMIT ?", (limit,))
    return {"count": len(rows), "limit": limit, "data": rows}


@app.get("/api/v1/prediction/early-warning")
def early_warning() -> dict[str, Any]:
    """Return an experimental Scikit-learn forecast when a model is trained."""
    return predict_latest()


@app.get("/api/v1/metrics/history")
def metrics_history(
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    interface: str | None = Query(None, min_length=1, max_length=255),
) -> dict[str, Any]:
    if interface is None:
        rows = _many(
            "SELECT * FROM metrics ORDER BY id DESC LIMIT ?", (limit,)
        )
    else:
        rows = _many(
            "SELECT * FROM metrics WHERE interface = ? ORDER BY id DESC LIMIT ?",
            (interface, limit),
        )
    return {"count": len(rows), "limit": limit, "data": rows}


@app.get("/api/v1/sla/events")
def sla_events(
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    status: str | None = Query(None, min_length=1, max_length=32),
) -> dict[str, Any]:
    if status is None:
        rows = _many("SELECT * FROM sla_events ORDER BY id DESC LIMIT ?", (limit,))
    else:
        rows = _many(
            "SELECT * FROM sla_events WHERE status = ? ORDER BY id DESC LIMIT ?",
            (status, limit),
        )
    return {"count": len(rows), "limit": limit, "data": rows}


@app.get("/restconf/data/telecom:interfaces")
def restconf_interfaces() -> dict[str, Any]:
    rows = _many(
        "SELECT m.* FROM metrics AS m "
        "JOIN (SELECT interface, MAX(id) AS latest_id FROM metrics GROUP BY interface) AS latest "
        "ON latest.latest_id = m.id ORDER BY m.interface"
    )
    return {"telecom:interfaces": {"interface": rows}}


@app.get("/restconf/data/telecom:services")
def restconf_services() -> dict[str, Any]:
    qos = _one("SELECT * FROM qos_metrics ORDER BY id DESC LIMIT 1")
    event = _one(
        "SELECT id, started_at, severity, reason, status FROM sla_events "
        "WHERE status = ? ORDER BY id DESC LIMIT 1",
        ("OPEN",),
    )
    service_status = qos.get("sla_status") if qos else "UNKNOWN"
    return {
        "telecom:services": {
            "service": [
                {
                    "name": "qos-monitoring",
                    "status": service_status,
                    "latest-measurement": qos,
                    "open-sla-event": event,
                }
            ]
        }
    }
