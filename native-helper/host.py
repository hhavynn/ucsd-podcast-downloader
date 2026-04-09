#!/usr/bin/env python3
"""
UCSD Podcast Downloader — Native Messaging Host
Milestone 3: ping/pong only. Real download logic comes in Milestone 4.

Chrome Native Messaging protocol (stdio):
  Each message is a 4-byte little-endian uint32 (length), followed by
  that many UTF-8 bytes of JSON. Responses use the same format.

Chrome launches this process fresh for every native messaging session
and kills it when the extension disconnects.
"""

import sys
import json
import struct
import logging

# Log to stderr only — stdout is reserved for the Chrome message protocol.
logging.basicConfig(stream=sys.stderr, level=logging.DEBUG,
                    format="[host.py] %(levelname)s %(message)s")

VERSION = "0.1.0"


def read_message() -> dict:
    """Read one message from Chrome via stdin."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        # Chrome closed the pipe — exit cleanly.
        sys.exit(0)
    length = struct.unpack("<I", raw_len)[0]
    raw_msg = sys.stdin.buffer.read(length)
    return json.loads(raw_msg.decode("utf-8"))


def send_message(payload: dict) -> None:
    """Write one message back to Chrome via stdout."""
    encoded = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def handle(message: dict) -> dict:
    msg_type = message.get("type")
    logging.debug("Received: %s", message)

    if msg_type == "ping":
        return {
            "type": "pong",
            "version": VERSION,
        }

    return {"error": f"Unknown message type: {msg_type!r}"}


def main():
    logging.debug("Native host started (v%s)", VERSION)
    while True:
        try:
            message = read_message()
            response = handle(message)
            send_message(response)
        except Exception as exc:
            logging.exception("Unhandled error")
            send_message({"error": str(exc)})


if __name__ == "__main__":
    main()
