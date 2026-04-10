#!/usr/bin/env python3
"""
UCSD Podcast Downloader — Native Messaging Host

Chrome Native Messaging protocol (stdio):
  Each message is a 4-byte little-endian uint32 (length), followed by
  that many UTF-8 bytes of JSON. Responses use the same format.

Chrome launches this process fresh for every native messaging session
and kills it when the extension disconnects.
"""

import sys
import json
import re
import shutil
import struct
import subprocess
import logging
from pathlib import Path

# Log to stderr only — stdout is reserved for the Chrome message protocol.
logging.basicConfig(stream=sys.stderr, level=logging.DEBUG,
                    format="[host.py] %(levelname)s %(message)s")

VERSION = "0.1.0"
OUTPUT_DIR = Path.home() / "Downloads" / "UCSD Podcasts"


# ── Protocol I/O ─────────────────────────────────────────────────────────────

def read_message() -> dict:
    """Read one message from Chrome via stdin."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        sys.exit(0)  # Chrome closed the pipe — exit cleanly
    length = struct.unpack("<I", raw_len)[0]
    raw_msg = sys.stdin.buffer.read(length)
    return json.loads(raw_msg.decode("utf-8"))


def send_message(payload: dict) -> None:
    """Write one message back to Chrome via stdout."""
    encoded = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


# ── Handlers ─────────────────────────────────────────────────────────────────

def handle_ping(_message: dict) -> dict:
    return {"type": "pong", "version": VERSION}


def sanitize_filename(raw: str) -> str:
    """Return a safe .mp4 filename from an arbitrary string."""
    # Remove characters that are illegal on Windows or macOS
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", raw)
    # Collapse whitespace
    name = re.sub(r"\s+", " ", name).strip()
    # Truncate to keep paths short on all platforms
    name = name[:100]
    return (name or "lecture") + ".mp4"


def handle_download(message: dict) -> dict:
    url      = message.get("url", "").strip()
    raw_name = message.get("filename", "lecture").strip()

    # ── Input validation ──────────────────────────────────────────────────────
    if not url:
        return {"ok": False, "message": "No URL provided."}
    if not url.startswith("https://"):
        return {"ok": False, "message": "URL must use https."}
    if ".m3u8" not in url:
        return {"ok": False, "message": "URL does not look like an HLS playlist (.m3u8 not found)."}

    if not shutil.which("yt-dlp"):
        return {
            "ok": False,
            "message": "yt-dlp not found. Install it with:\n  pip install yt-dlp\nThen restart Chrome."
        }

    # ── Prepare output path ───────────────────────────────────────────────────
    filename = sanitize_filename(raw_name)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / filename
    logging.info("Starting download → %s", output_path)

    # ── Run yt-dlp ───────────────────────────────────────────────────────────
    # --no-part       : write directly to the final file (no .part temp file)
    # --merge-output-format mp4 : ensure the container is always .mp4
    cmd = [
        "yt-dlp",
        "--no-part",
        "--merge-output-format", "mp4",
        "-o", str(output_path),
        url,
    ]
    logging.debug("Running: %s", " ".join(cmd))

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=7200,  # 2-hour ceiling for very long lectures
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": "Download timed out after 2 hours."}
    except FileNotFoundError:
        return {"ok": False, "message": "yt-dlp executable not found. Check your PATH."}

    # ── Interpret result ──────────────────────────────────────────────────────
    if result.returncode != 0:
        # Combine stdout + stderr; yt-dlp mixes its output across both
        combined = (result.stderr + "\n" + result.stdout).strip()
        logging.error("yt-dlp failed (rc=%d):\n%s", result.returncode, combined)
        return {"ok": False, "message": _classify_error(combined)}

    if not output_path.exists():
        return {
            "ok": False,
            "message": (
                "yt-dlp exited successfully but the output file was not found.\n"
                f"Expected: {output_path}"
            )
        }

    size_mb = output_path.stat().st_size / (1024 * 1024)
    logging.info("Done. %.1f MB → %s", size_mb, output_path)
    return {
        "ok": True,
        "message": f"{size_mb:.1f} MB",
        "path": str(output_path),
    }


def _classify_error(output: str) -> str:
    """Return a human-readable error for common yt-dlp failures."""
    lo = output.lower()

    if "403" in output or "forbidden" in lo:
        return (
            "Stream URL has expired (HTTP 403).\n"
            "Reload the lecture page, let the video start playing, then try again."
        )
    if "401" in output or "unauthorized" in lo:
        return "Authentication error. Make sure you are logged into the UCSD podcast portal."
    if "unable to extract" in lo or "unsupported url" in lo:
        return "yt-dlp could not parse this URL. It may be an unsupported format."
    if "network" in lo or "connection" in lo or "timed out" in lo:
        return "Network error during download. Check your internet connection and try again."

    # Generic fallback — show the tail of yt-dlp output for debugging
    tail = output[-400:].strip()
    return f"yt-dlp error:\n{tail}"


# ── Dispatcher ────────────────────────────────────────────────────────────────

def handle(message: dict) -> dict:
    msg_type = message.get("type")
    logging.debug("Received type=%r", msg_type)

    if msg_type == "ping":
        return handle_ping(message)
    if msg_type == "download_video":
        return handle_download(message)

    return {"ok": False, "message": f"Unknown message type: {msg_type!r}"}


# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    logging.debug("Native host started (v%s)", VERSION)
    while True:
        try:
            message = read_message()
            response = handle(message)
            send_message(response)
        except Exception as exc:
            logging.exception("Unhandled error")
            send_message({"ok": False, "message": str(exc)})


if __name__ == "__main__":
    main()
