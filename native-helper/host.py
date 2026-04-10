#!/usr/bin/env python3
"""
UCSD Podcast Downloader - Native Messaging Host

Chrome Native Messaging protocol (stdio):
  Each message is a 4-byte little-endian uint32 (length), followed by
  that many UTF-8 bytes of JSON. Responses use the same format.

Chrome launches this process fresh for every native messaging session
and kills it when the extension disconnects.
"""

import json
import logging
import re
import shutil
import struct
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path

# Log to stderr only - stdout is reserved for the Chrome message protocol.
logging.basicConfig(
    stream=sys.stderr,
    level=logging.DEBUG,
    format="[host.py] %(levelname)s %(message)s",
)

VERSION = "0.1.0"
OUTPUT_DIR = Path.home() / "Downloads" / "UCSD Podcasts"
DOWNLOAD_TIMEOUT_SECONDS = 7200
TAIL_LINES = 40

PERCENT_RE = re.compile(r"(?P<percent>\d+(?:\.\d+)?)%")
SPEED_RE = re.compile(r"\bat\s+(?P<speed>.+?)(?:\s+ETA(?:\s|$)|\s*$)")
ETA_RE = re.compile(r"\bETA\s+(?P<eta>[0-9:]+)")
DOWNLOADED_BYTES_RE = re.compile(
    r"\b(?P<downloaded>[0-9]+(?:\.[0-9]+)?(?:[KMGTP]?i?B))(?=\s+(?:at|in)\b)"
)
MERGE_MARKERS = (
    "Merging formats into",
    "Fixing MPEG-TS in MP4 container",
)


def read_message() -> dict:
    """Read one message from Chrome via stdin."""
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
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


def handle_ping(_message: dict) -> dict:
    return {"type": "pong", "version": VERSION}


def sanitize_filename(raw: str) -> str:
    """Return a safe .mp4 filename from an arbitrary string."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", raw)
    name = re.sub(r"\s+", " ", name).strip()
    name = name[:100]
    return (name or "lecture") + ".mp4"


def emit_event(event_type: str, tab_id, **payload) -> None:
    message = {"type": event_type, "tabId": tab_id}
    message.update(payload)
    logging.debug("Emitting %s -> %s", event_type, payload)
    send_message(message)


def format_percent(value: float | None) -> str:
    if value is None:
        return ""
    text = f"{value:.1f}"
    return text[:-2] if text.endswith(".0") else text


def parse_progress_line(line: str) -> dict | None:
    if "[download]" not in line:
        return None

    percent_match = PERCENT_RE.search(line)
    speed_match = SPEED_RE.search(line)
    eta_match = ETA_RE.search(line)
    downloaded_match = None

    if " of " not in line:
        downloaded_match = DOWNLOADED_BYTES_RE.search(line)

    percent = round(float(percent_match.group("percent")), 1) if percent_match else None
    speed_text = speed_match.group("speed").strip() if speed_match else ""
    eta_text = eta_match.group("eta").strip() if eta_match else ""
    downloaded_text = downloaded_match.group("downloaded").strip() if downloaded_match else ""

    if percent is None and not speed_text and not eta_text and not downloaded_text:
        return None

    if percent is not None:
        message = f"Downloading... {format_percent(percent)}%"
    else:
        message = "Downloading..."

    return {
        "percent": percent,
        "speedText": speed_text,
        "etaText": eta_text,
        "downloadedBytesText": downloaded_text,
        "message": message,
    }


def _validate_download_request(tab_id, url: str) -> str | None:
    if tab_id is None:
        return "Missing tabId."
    if not url:
        return "No URL provided."
    if not url.startswith("https://"):
        return "URL must use https."
    if ".m3u8" not in url:
        return "URL does not look like an HLS playlist (.m3u8 not found)."
    if not shutil.which("yt-dlp"):
        return "yt-dlp not found. Install it with:\n  pip install yt-dlp\nThen restart Chrome."
    return None


def handle_download(message: dict) -> None:
    tab_id = message.get("tabId")
    url = str(message.get("url", "")).strip()
    raw_name = str(message.get("filename", "lecture")).strip()

    validation_error = _validate_download_request(tab_id, url)
    if validation_error:
        emit_event("download_error", tab_id, message=validation_error)
        return

    filename = sanitize_filename(raw_name)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / filename
    logging.info("Starting download -> %s", output_path)

    emit_event("download_started", tab_id, message="Preparing download...")

    cmd = [
        "yt-dlp",
        "--newline",
        "--no-part",
        "--merge-output-format",
        "mp4",
        "-o",
        str(output_path),
        url,
    ]
    logging.debug("Running: %s", " ".join(cmd))

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except FileNotFoundError:
        emit_event("download_error", tab_id, message="yt-dlp executable not found. Check your PATH.")
        return

    timed_out = threading.Event()
    tail_output = deque(maxlen=TAIL_LINES)
    last_progress = {
        "percent": None,
        "speedText": "",
        "etaText": "",
        "downloadedBytesText": "",
        "message": "Downloading...",
    }

    def kill_process() -> None:
        timed_out.set()
        logging.error("Download timed out after %s seconds", DOWNLOAD_TIMEOUT_SECONDS)
        process.kill()

    timer = threading.Timer(DOWNLOAD_TIMEOUT_SECONDS, kill_process)
    timer.start()

    try:
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line:
                continue

            tail_output.append(line)
            logging.debug("yt-dlp: %s", line)

            if any(marker in line for marker in MERGE_MARKERS):
                emit_event("download_merging", tab_id, message="Merging...")
                continue

            progress = parse_progress_line(line)
            if not progress:
                continue

            last_progress.update(progress)
            emit_event(
                "download_progress",
                tab_id,
                percent=last_progress["percent"],
                speedText=last_progress["speedText"],
                etaText=last_progress["etaText"],
                downloadedBytesText=last_progress["downloadedBytesText"],
                message=last_progress["message"],
            )

        process.wait()
    finally:
        timer.cancel()
        if process.stdout is not None:
            process.stdout.close()

    if timed_out.is_set():
        emit_event("download_error", tab_id, message="Download timed out after 2 hours.")
        return

    if process.returncode != 0:
        combined = "\n".join(tail_output).strip()
        logging.error("yt-dlp failed (rc=%d):\n%s", process.returncode, combined)
        emit_event("download_error", tab_id, message=_classify_error(combined))
        return

    if not output_path.exists():
        emit_event(
            "download_error",
            tab_id,
            message=(
                "yt-dlp exited successfully but the output file was not found.\n"
                f"Expected: {output_path}"
            ),
        )
        return

    size_mb = output_path.stat().st_size / (1024 * 1024)
    logging.info("Done. %.1f MB -> %s", size_mb, output_path)
    emit_event(
        "download_done",
        tab_id,
        path=str(output_path),
        message=f"{size_mb:.1f} MB",
    )


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

    tail = output[-400:].strip()
    return f"yt-dlp error:\n{tail}"


def handle(message: dict) -> dict | None:
    msg_type = message.get("type")
    logging.debug("Received type=%r", msg_type)

    if msg_type == "ping":
        return handle_ping(message)
    if msg_type == "download_video":
        handle_download(message)
        return None

    return {"ok": False, "message": f"Unknown message type: {msg_type!r}"}


def main() -> None:
    logging.debug("Native host started (v%s)", VERSION)
    while True:
        message = None
        try:
            message = read_message()
            response = handle(message)
            if response is not None:
                send_message(response)
        except Exception as exc:
            logging.exception("Unhandled error")
            if message and message.get("type") == "download_video":
                emit_event("download_error", message.get("tabId"), message=str(exc))
            else:
                send_message({"ok": False, "message": str(exc)})


if __name__ == "__main__":
    main()
