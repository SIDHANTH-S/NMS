#!/usr/bin/env python3
"""Train and chronologically evaluate the experimental QoS early-warning model."""

import json

from predictor import train_and_evaluate


if __name__ == "__main__":
    try:
        print(json.dumps(train_and_evaluate(), indent=2))
    except (ValueError, OSError) as exc:
        raise SystemExit(f"Model training stopped: {exc}") from exc
