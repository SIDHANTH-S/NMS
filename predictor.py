"""Experimental next-window QoS breach prediction using Scikit-learn."""

from __future__ import annotations

import json
import sqlite3
from bisect import bisect_right
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "metrics.db"
MODEL_PATH = BASE_DIR / "qos_risk_model.joblib"
REPORT_PATH = BASE_DIR / "qos_model_report.json"
HORIZON_SAMPLES = 3
MAX_METRIC_AGE_SECONDS = 30.0
FEATURES = [
    "latency_current_ms", "latency_mean_3_ms", "latency_max_5_ms", "latency_slope_3_ms",
    "latency_missing", "loss_current_pct", "loss_mean_3_pct", "loss_max_5_pct", "loss_slope_3_pct",
    "r0_rx_mbps", "r0_tx_mbps", "r1_rx_mbps", "r1_tx_mbps",
]


def _epoch(value: str) -> float:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def load_history() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Read samples without modifying metrics.db."""
    conn = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        qos = [dict(row) for row in conn.execute("SELECT * FROM qos_metrics ORDER BY id")]
        traffic = [dict(row) for row in conn.execute("SELECT * FROM metrics ORDER BY id")]
        return qos, traffic
    finally:
        conn.close()


def build_examples(
    qos_rows: list[dict[str, Any]], traffic_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, float]], list[int], list[dict[str, Any]]]:
    """Build past-only rolling features; label a breach in the next 3 QoS samples."""
    ordered_qos = sorted(qos_rows, key=lambda row: row["id"])
    traffic_by_interface: dict[str, list[tuple[float, dict[str, Any]]]] = {}
    for row in traffic_rows:
        traffic_by_interface.setdefault(row["interface"], []).append((_epoch(row["timestamp"]), row))
    for rows in traffic_by_interface.values():
        rows.sort(key=lambda item: item[0])
    traffic_times = {name: [item[0] for item in rows] for name, rows in traffic_by_interface.items()}

    features: list[dict[str, float]] = []
    labels: list[int] = []
    metadata: list[dict[str, Any]] = []
    for index, row in enumerate(ordered_qos):
        if index + HORIZON_SAMPLES >= len(ordered_qos):
            break
        if row.get("sla_status") not in {"NORMAL", "BREACH"}:
            continue
        future = ordered_qos[index + 1:index + 1 + HORIZON_SAMPLES]
        if any(item.get("sla_status") not in {"NORMAL", "BREACH"} for item in future):
            continue
        current_time = _epoch(row["timestamp"])
        latency_window = [item["latency_avg_ms"] for item in ordered_qos[max(0, index - 4):index + 1]]
        latency_values = [float(value) for value in latency_window if value is not None]
        latency_recent = [item["latency_avg_ms"] for item in ordered_qos[max(0, index - 2):index + 1]]
        latency_recent_values = [float(value) for value in latency_recent if value is not None]
        loss_window = [float(item["packet_loss_pct"] or 0.0) for item in ordered_qos[max(0, index - 4):index + 1]]
        loss_recent = [float(item["packet_loss_pct"] or 0.0) for item in ordered_qos[max(0, index - 2):index + 1]]
        latency_first = latency_recent_values[0] if latency_recent_values else 0.0
        latency_last = latency_recent_values[-1] if latency_recent_values else 0.0
        loss_first = loss_recent[0] if loss_recent else 0.0
        loss_last = loss_recent[-1] if loss_recent else 0.0
        current_latency = row["latency_avg_ms"]

        feature: dict[str, float] = {
            "latency_current_ms": float(current_latency) if current_latency is not None else np.nan,
            "latency_mean_3_ms": float(np.mean(latency_recent_values)) if latency_recent_values else np.nan,
            "latency_max_5_ms": max(latency_values) if latency_values else np.nan,
            "latency_slope_3_ms": latency_last - latency_first,
            "latency_missing": float(current_latency is None),
            "loss_current_pct": float(row["packet_loss_pct"] or 0.0),
            "loss_mean_3_pct": float(np.mean(loss_recent)) if loss_recent else 0.0,
            "loss_max_5_pct": max(loss_window) if loss_window else 0.0,
            "loss_slope_3_pct": loss_last - loss_first,
        }
        for interface in ("r0", "r1"):
            rows = traffic_by_interface.get(interface, [])
            times = traffic_times.get(interface, [])
            position = bisect_right(times, current_time) - 1
            sample = rows[position][1] if position >= 0 else None
            if sample is not None and current_time - rows[position][0] > MAX_METRIC_AGE_SECONDS:
                sample = None
            feature[f"{interface}_rx_mbps"] = float(sample["rx_mbps"]) if sample and sample["rx_mbps"] is not None else np.nan
            feature[f"{interface}_tx_mbps"] = float(sample["tx_mbps"]) if sample and sample["tx_mbps"] is not None else np.nan

        labels.append(int(any(item["sla_status"] == "BREACH" for item in future)))
        features.append(feature)
        metadata.append({"id": row["id"], "timestamp": row["timestamp"], "status": row["sla_status"]})
    return features, labels, metadata


def make_model():
    return make_pipeline(
        SimpleImputer(strategy="median", add_indicator=True),
        StandardScaler(),
        LogisticRegression(class_weight="balanced", max_iter=2000, random_state=42),
    )


def train_and_evaluate() -> dict[str, Any]:
    qos, traffic = load_history()
    X_rows, y, metadata = build_examples(qos, traffic)
    if len(X_rows) < 30 or sum(y) < 6 or len(set(y)) < 2:
        raise ValueError("Need at least 30 usable rows and 6 positive/negative forecast labels before training")
    X = np.asarray([[row[name] for name in FEATURES] for row in X_rows], dtype=float)

    split = max(1, int(len(y) * 0.8))
    evaluation = {"method": "chronological 80/20 holdout", "train_rows": split, "test_rows": len(y) - split}
    if len(set(y[:split])) < 2:
        evaluation.update({"status": "not_evaluable", "note": "Training segment does not contain both classes"})
    else:
        eval_model = make_model().fit(X[:split], y[:split])
        test_y = np.asarray(y[split:])
        test_prob = eval_model.predict_proba(X[split:])[:, 1] if len(test_y) else np.asarray([])
        test_pred = (test_prob >= 0.5).astype(int)
        positives = int(test_y.sum())
        evaluation.update({
            "status": "limited_no_positive_holdout" if positives == 0 else "evaluated",
            "test_positive_rows": positives,
            "test_negative_rows": int(len(test_y) - positives),
            "threshold_pct": 50,
            "true_positives": int(((test_pred == 1) & (test_y == 1)).sum()),
            "false_positives": int(((test_pred == 1) & (test_y == 0)).sum()),
            "false_negatives": int(((test_pred == 0) & (test_y == 1)).sum()),
            "precision": None if positives == 0 else float(((test_pred == 1) & (test_y == 1)).sum() / max(1, (test_pred == 1).sum())),
            "recall": None if positives == 0 else float(((test_pred == 1) & (test_y == 1)).sum() / positives),
        })

    model = make_model().fit(X, y)
    trained_at = datetime.now(timezone.utc).isoformat()
    artifact = {
        "model": model,
        "trained_at": trained_at,
        "max_sample_id": qos[-1]["id"],
        "labeled_through_sample_id": max(item["id"] for item in metadata),
        "training_rows": len(y),
        "training_positive_rows": int(sum(y)),
        "features": FEATURES,
        "horizon_samples": HORIZON_SAMPLES,
    }
    joblib.dump(artifact, MODEL_PATH)
    report = {
        "model": "Scikit-learn LogisticRegression with median imputation and feature scaling",
        "prediction_target": "At least one SLA breach in the next 3 QoS samples",
        "training_rows": len(y),
        "training_positive_rows": int(sum(y)),
        "training_negative_rows": int(len(y) - sum(y)),
        "latest_sample_id": artifact["max_sample_id"],
        "trained_at": trained_at,
        "evaluation": evaluation,
        "limitation": "Small, scenario-specific dataset. The risk score is uncalibrated and must not be used as an SLA decision.",
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def predict_latest() -> dict[str, Any]:
    if not MODEL_PATH.is_file():
        return {"available": False, "reason": "Model is not trained. Run train_qos_model.py."}
    qos, traffic = load_history()
    if not qos:
        return {"available": False, "reason": "No QoS measurements are available."}
    latest_row = qos[-1]
    try:
        age_seconds = datetime.now(timezone.utc).timestamp() - _epoch(latest_row["timestamp"])
    except (TypeError, ValueError):
        return {"available": False, "reason": "Latest QoS timestamp is invalid.", "experimental": True}
    if age_seconds < -5 or age_seconds > MAX_METRIC_AGE_SECONDS:
        return {"available": False, "reason": "Latest QoS measurement is stale.", "experimental": True}
    if latest_row.get("sla_status") != "NORMAL":
        return {"available": False, "reason": "Prediction is unavailable unless the latest QoS probe is NORMAL.", "experimental": True}
    if (
        latest_row.get("latency_avg_ms") is None
        or latest_row.get("packet_loss_pct") is None
        or not latest_row.get("packets_sent")
        or latest_row.get("packets_received") is None
    ):
        return {"available": False, "reason": "Latest QoS measurement is incomplete.", "experimental": True}
    artifact = joblib.load(MODEL_PATH)
    features, _, _ = build_examples(qos, traffic)
    # build_examples omits the last three rows because they have no future label.
    # Build current features by appending unlabeled copies and reusing the same past-only logic.
    extended = qos + [dict(qos[-1], id=qos[-1]["id"] + i + 1, timestamp=qos[-1]["timestamp"], sla_status="NORMAL") for i in range(HORIZON_SAMPLES)]
    current_features, _, current_metadata = build_examples(extended, traffic)
    latest_position = next((i for i, item in enumerate(current_metadata) if item["id"] == latest_row["id"]), None)
    if latest_position is None:
        return {"available": False, "reason": "Latest QoS sample cannot be used for prediction.", "experimental": True}
    latest = current_features[latest_position]
    latest_vector = np.asarray([[latest[name] for name in FEATURES]], dtype=float)
    score = float(artifact["model"].predict_proba(latest_vector)[0][1])
    latest_id = latest_row["id"]
    return {
        "available": True,
        "risk_score_pct": round(score * 100, 1),
        "horizon_samples": HORIZON_SAMPLES,
        "current_sla_status": qos[-1]["sla_status"],
        "latest_sample_id": latest_id,
        "latest_sample_timestamp": qos[-1]["timestamp"],
        "model_trained_through_sample_id": artifact["max_sample_id"],
        "new_samples_since_training": max(0, latest_id - artifact["max_sample_id"]),
        "trained_at": artifact["trained_at"],
        "score_type": "uncalibrated_model_score",
        "experimental": True,
    }
