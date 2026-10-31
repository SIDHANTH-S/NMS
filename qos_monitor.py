"""QoS probe and SLA lifecycle monitor for the ASSURENET lab."""

import os
import re
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

DB_FILE = Path(__file__).resolve().with_name("metrics.db")
TARGET_IP = os.getenv("ASSURENET_QOS_TARGET", "10.10.2.2")
MAX_LATENCY_MS = float(os.getenv("ASSURENET_MAX_LATENCY_MS", "50"))
MAX_PACKET_LOSS = float(os.getenv("ASSURENET_MAX_PACKET_LOSS", "1"))
PING_COUNT = int(os.getenv("ASSURENET_PING_COUNT", "5"))
INTERVAL_SECONDS = int(os.getenv("ASSURENET_QOS_INTERVAL", "10"))
DB_BUSY_TIMEOUT_MS = 3000
DB_WRITE_ATTEMPTS = 6


def initialize_database():
    conn = sqlite3.connect(DB_FILE, timeout=DB_BUSY_TIMEOUT_MS / 1000)
    conn.execute(f"PRAGMA busy_timeout = {DB_BUSY_TIMEOUT_MS}")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS qos_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL, target_ip TEXT NOT NULL,
            packets_sent INTEGER, packets_received INTEGER,
            packet_loss_pct REAL, latency_avg_ms REAL,
            sla_status TEXT NOT NULL, breach_reason TEXT
        )
    """)
    conn.commit()
    return conn


def measure_qos():
    """Return probe values; raise RuntimeError if ping itself failed."""
    try:
        result = subprocess.run(
            ["/usr/bin/ping", "-n", "-c", str(PING_COUNT), "-i", "0.2",
             "-W", "2", TARGET_IP],
            capture_output=True, text=True, timeout=max(10, PING_COUNT * 2 + 5),
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("ping executable /usr/bin/ping is missing") from exc
    except subprocess.TimeoutExpired as exc:
        detail = (exc.stderr or b"").decode(errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        raise RuntimeError(f"ping timed out: {detail.strip() or 'probe exceeded its timeout'}") from exc
    except OSError as exc:
        raise RuntimeError(f"could not execute ping: {exc}") from exc

    output = result.stdout or ""
    error = (result.stderr or "").strip()
    sent_match = re.search(r"(\d+) packets transmitted", output)
    received_match = re.search(r"(\d+) received", output)
    loss_match = re.search(r"([\d.]+)% packet loss", output)
    latency_match = re.search(r"= [\d.]+/([\d.]+)/[\d.]+/[\d.]+ ms", output)

    # iputils returns 1 when the command ran but got no replies; its summary is
    # the evidence that this was real packet loss rather than a probe failure.
    execution_error = re.search(
        r"operation not permitted|permission denied|network is unreachable|"
        r"temporary failure in name resolution|name or service not known|"
        r"no such device|cannot bind|socket:",
        f"{output}\n{error}", re.IGNORECASE,
    )
    if execution_error or result.returncode not in (0, 1) or not sent_match or not loss_match:
        detail = error or output.strip() or f"ping exited with status {result.returncode}"
        raise RuntimeError(f"ping execution failed (exit {result.returncode}): {detail}")
    if result.returncode == 0 and not received_match:
        raise RuntimeError(f"ping returned success without a reply summary: {output.strip() or error}")

    sent = int(sent_match.group(1))
    received = int(received_match.group(1)) if received_match else 0
    loss = float(loss_match.group(1))
    latency = float(latency_match.group(1)) if latency_match else None
    if sent <= 0 or received > sent or not 0.0 <= loss <= 100.0:
        raise RuntimeError(f"ping returned an invalid packet summary: {output.strip()}")
    if received > 0 and latency is None:
        raise RuntimeError(f"ping received replies but returned no latency summary: {output.strip()}")
    return sent, received, loss, latency


def evaluate_sla(loss, latency):
    reasons = []
    if loss > MAX_PACKET_LOSS:
        reasons.append(f"Packet loss {loss}% exceeds {MAX_PACKET_LOSS}%")
    if latency is not None and latency > MAX_LATENCY_MS:
        reasons.append(f"Latency {latency} ms exceeds {MAX_LATENCY_MS} ms")
    return ("BREACH", "; ".join(reasons)) if reasons else ("NORMAL", None)


def _write_transaction(conn, operation):
    """Run a short atomic write and retry only SQLite BUSY/LOCKED errors."""
    delay = 0.1
    for attempt in range(DB_WRITE_ATTEMPTS):
        try:
            conn.execute("BEGIN IMMEDIATE")
            operation()
            conn.commit()
            return
        except sqlite3.OperationalError as exc:
            conn.rollback()
            code = getattr(exc, "sqlite_errorcode", None)
            busy_codes = {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}
            if code not in busy_codes and not any(word in str(exc).lower() for word in ("database is locked", "database is busy")):
                raise
            if attempt + 1 == DB_WRITE_ATTEMPTS:
                raise
            print(f"SQLite is busy; retry {attempt + 1}/{DB_WRITE_ATTEMPTS - 1} in {delay:.1f}s")
            time.sleep(delay)
            delay = min(delay * 2, 1.6)
        except Exception:
            conn.rollback()
            raise


def record_sla_event(conn, timestamp, status, reason, latency, loss):
    """Create/update only on breaches; resolve only on a real NORMAL sample."""
    if status == "UNKNOWN":
        return
    event = conn.execute("""
        SELECT id, started_at, peak_latency_ms, peak_packet_loss_pct
        FROM sla_events WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1
    """).fetchone()

    if status == "BREACH":
        if event is None:
            severity = "CRITICAL" if reason and "Packet loss" in reason and "Latency" in reason else "MAJOR"
            conn.execute("""INSERT INTO sla_events (
                started_at, severity, reason, peak_latency_ms,
                peak_packet_loss_pct, status
            ) VALUES (?, ?, ?, ?, ?, 'OPEN')""", (timestamp, severity, reason or "SLA breach", latency, loss))
        else:
            event_id, _, peak_latency, peak_loss = event
            peak_latency = max(peak_latency, latency) if peak_latency is not None and latency is not None else (peak_latency if latency is None else latency)
            peak_loss = max(peak_loss, loss) if peak_loss is not None and loss is not None else (peak_loss if loss is None else loss)
            conn.execute("""UPDATE sla_events SET reason = ?, peak_latency_ms = ?,
                peak_packet_loss_pct = ? WHERE id = ? AND status = 'OPEN'""",
                (reason or "SLA breach", peak_latency, peak_loss, event_id))
    elif status == "NORMAL" and event is not None:
        event_id, started_at, _, _ = event
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        resolved = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        duration = max(0.0, (resolved - started).total_seconds())
        conn.execute("""UPDATE sla_events SET resolved_at = ?, duration_seconds = ?, status = 'CLOSED'
            WHERE id = ? AND status = 'OPEN'""", (timestamp, duration, event_id))


def main():
    conn = initialize_database()
    print("QoS monitoring + SLA evaluation started.")
    print(f"Target: {TARGET_IP}\nLatency limit: {MAX_LATENCY_MS} ms\nPacket loss limit: {MAX_PACKET_LOSS}%\n")
    try:
        while True:
            timestamp = datetime.now(timezone.utc).isoformat()
            try:
                sent, received, loss, latency = measure_qos()
                status, reason = evaluate_sla(loss, latency)
            except RuntimeError as exc:
                sent = received = loss = latency = None
                status, reason = "UNKNOWN", f"Probe error: {exc}"
                print(f"QoS probe error: {exc}")

            def save_sample():
                conn.execute("""INSERT INTO qos_metrics (
                    timestamp, target_ip, packets_sent, packets_received,
                    packet_loss_pct, latency_avg_ms, sla_status, breach_reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (timestamp, TARGET_IP, sent, received, loss, latency, status, reason))
                record_sla_event(conn, timestamp, status, reason, latency, loss)

            _write_transaction(conn, save_sample)
            print(f"Time: {timestamp}\nLatency: {latency if latency is not None else 'Unavailable'} ms")
            print(f"Packet loss: {loss if loss is not None else 'Unavailable'}%\nSLA status: {status}")
            if reason:
                print(f"Reason: {reason}")
            print("-" * 45)
            time.sleep(INTERVAL_SECONDS)
    except KeyboardInterrupt:
        print("\nQoS monitoring stopped.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
