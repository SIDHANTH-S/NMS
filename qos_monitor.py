import re
import sqlite3
import subprocess
import time
from datetime import datetime, timezone

DB_FILE = "metrics.db"
TARGET_IP = "10.10.2.2"
MAX_LATENCY_MS = 50.0
MAX_PACKET_LOSS = 1.0
PING_COUNT = 5
INTERVAL_SECONDS = 10


def initialize_database():
    conn = sqlite3.connect(DB_FILE)
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
    result = subprocess.run(
        ["ping", "-n", "-c", str(PING_COUNT), "-i", "0.2",
         "-W", "2", TARGET_IP],
        capture_output=True, text=True
    )
    output = result.stdout
    sent_match = re.search(r"(\d+) packets transmitted", output)
    received_match = re.search(r"(\d+) received", output)
    loss_match = re.search(r"([\d.]+)% packet loss", output)
    latency_match = re.search(
        r"= [\d.]+/([\d.]+)/[\d.]+/[\d.]+ ms", output
    )
    sent = int(sent_match.group(1)) if sent_match else PING_COUNT
    received = int(received_match.group(1)) if received_match else 0
    loss = float(loss_match.group(1)) if loss_match else 100.0
    latency = float(latency_match.group(1)) if latency_match else None
    return sent, received, loss, latency


def evaluate_sla(loss, latency):
    reasons = []
    if loss > MAX_PACKET_LOSS:
        reasons.append(f"Packet loss {loss}% exceeds {MAX_PACKET_LOSS}%")
    if latency is not None and latency > MAX_LATENCY_MS:
        reasons.append(f"Latency {latency} ms exceeds {MAX_LATENCY_MS} ms")
    return ("BREACH", "; ".join(reasons)) if reasons else ("NORMAL", None)


def record_sla_event(conn, timestamp, status, reason, latency, loss):
    """Create, update, or resolve the current SLA incident."""
    event = conn.execute("""
        SELECT id, started_at, peak_latency_ms, peak_packet_loss_pct
        FROM sla_events WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1
    """).fetchone()

    if status == "BREACH":
        if event is None:
            severity = (
                "CRITICAL"
                if reason and "Packet loss" in reason and "Latency" in reason
                else "MAJOR"
            )
            conn.execute("""
                INSERT INTO sla_events (
                    started_at, severity, reason, peak_latency_ms,
                    peak_packet_loss_pct, status
                ) VALUES (?, ?, ?, ?, ?, 'OPEN')
            """, (timestamp, severity, reason or "SLA breach", latency, loss))
        else:
            event_id, _, peak_latency, peak_loss = event
            peak_latency = (
                max(peak_latency, latency)
                if peak_latency is not None and latency is not None
                else peak_latency if latency is None else latency
            )
            peak_loss = (
                max(peak_loss, loss)
                if peak_loss is not None and loss is not None
                else peak_loss if loss is None else loss
            )
            conn.execute("""
                UPDATE sla_events SET reason = ?, peak_latency_ms = ?,
                    peak_packet_loss_pct = ?
                WHERE id = ? AND status = 'OPEN'
            """, (reason or "SLA breach", peak_latency, peak_loss, event_id))
    elif event is not None:
        event_id, started_at, _, _ = event
        started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        resolved = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        duration = max(0.0, (resolved - started).total_seconds())
        conn.execute("""
            UPDATE sla_events
            SET resolved_at = ?, duration_seconds = ?, status = 'CLOSED'
            WHERE id = ? AND status = 'OPEN'
        """, (timestamp, duration, event_id))


def main():
    conn = initialize_database()
    print("QoS monitoring + SLA evaluation started.")
    print(f"Target: {TARGET_IP}")
    print(f"Latency limit: {MAX_LATENCY_MS} ms")
    print(f"Packet loss limit: {MAX_PACKET_LOSS}%\n")
    try:
        while True:
            timestamp = datetime.now(timezone.utc).isoformat()
            sent, received, loss, latency = measure_qos()
            status, reason = evaluate_sla(loss, latency)
            with conn:
                conn.execute("""
                    INSERT INTO qos_metrics (
                        timestamp, target_ip, packets_sent,
                        packets_received, packet_loss_pct,
                        latency_avg_ms, sla_status, breach_reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (timestamp, TARGET_IP, sent, received,
                      loss, latency, status, reason))
                record_sla_event(conn, timestamp, status, reason, latency, loss)
            print(f"Time: {timestamp}")
            print(f"Latency: {latency if latency is not None else 'Unavailable'} ms")
            print(f"Packet loss: {loss}%")
            print(f"SLA status: {status}")
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
