import asyncio
import sqlite3
import time
from datetime import datetime, timezone

from pysnmp.hlapi.v3arch.asyncio import (
    SnmpEngine,
    CommunityData,
    UdpTransportTarget,
    ContextData,
    ObjectType,
    ObjectIdentity,
    get_cmd,
)

ROUTER_IP = "10.10.1.1"
COMMUNITY = "public"
DB_FILE = "metrics.db"

INTERFACES = {
    "r0": {
        "rx": "1.3.6.1.2.1.2.2.1.10.3",
        "tx": "1.3.6.1.2.1.2.2.1.16.3",
    },
    "r1": {
        "rx": "1.3.6.1.2.1.2.2.1.10.6",
        "tx": "1.3.6.1.2.1.2.2.1.16.6",
    },
}


def initialize_database():
    # The QoS monitor writes to the same SQLite file; wait for its short
    # transaction instead of terminating the collector on a lock.
    conn = sqlite3.connect(DB_FILE, timeout=30.0)
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            interface TEXT NOT NULL,
            rx_bytes INTEGER NOT NULL,
            tx_bytes INTEGER NOT NULL,
            rx_mbps REAL,
            tx_mbps REAL
        )
    """)
    conn.commit()
    return conn


async def get_counter(engine, target, oid):
    result = await get_cmd(
        engine,
        CommunityData(COMMUNITY, mpModel=1),
        target,
        ContextData(),
        ObjectType(ObjectIdentity(oid)),
    )

    error, status, index, bindings = result

    if error:
        raise RuntimeError(str(error))
    if status:
        raise RuntimeError(str(status))

    return int(bindings[0][1])


async def main():
    engine = SnmpEngine()
    target = await UdpTransportTarget.create(
        (ROUTER_IP, 161), timeout=2, retries=1
    )

    conn = initialize_database()

    previous = {}
    previous_time = None

    print("SNMP collector + SQLite storage started.")

    try:
        while True:
            cycle_start = time.monotonic()
            timestamp = datetime.now(timezone.utc).isoformat()

            for interface, oids in INTERFACES.items():
                rx = await get_counter(engine, target, oids["rx"])
                tx = await get_counter(engine, target, oids["tx"])

                rx_mbps = None
                tx_mbps = None

                if interface in previous and previous_time is not None:
                    elapsed = cycle_start - previous_time

                    if elapsed > 0:
                        old_rx, old_tx = previous[interface]

                        rx_delta = (rx - old_rx) % (2**32)
                        tx_delta = (tx - old_tx) % (2**32)

                        rx_mbps = rx_delta * 8 / elapsed / 1_000_000
                        tx_mbps = tx_delta * 8 / elapsed / 1_000_000

                conn.execute("""
                    INSERT INTO metrics
                    (timestamp, interface, rx_bytes, tx_bytes,
                     rx_mbps, tx_mbps)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (timestamp, interface, rx, tx, rx_mbps, tx_mbps))

                print(
                    f"{interface} | RX: {rx_mbps if rx_mbps is not None else 'Initial'} "
                    f"Mbps | TX: {tx_mbps if tx_mbps is not None else 'Initial'} Mbps"
                )

                previous[interface] = (rx, tx)

            conn.commit()
            previous_time = cycle_start

            print(f"Saved measurements at {timestamp}\n")

            await asyncio.sleep(5)

    finally:
        conn.close()
        engine.close_dispatcher()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nCollector stopped.")
    except Exception as exc:
        print(f"\nCollector error: {exc}")
