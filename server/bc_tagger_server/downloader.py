"""Wrapper around bandcamp-collection-downloader for small, filtered sets (A7).

Safety: a non-wildcard ``--string-filter`` is required, at most ``MAX_ITEMS`` releases per
run, and the download folder must be inside ``test-downloads/`` (never the music drive).
The downloader writes ``<folder>/<artist>/<year> - <release>/``, which the indexer scans
as the "owned" root.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any

from .config import PROTECTED_VOLUME, TEST_OWNED_ROOT
from .rbguard import is_within, resolve

MAX_ITEMS = 5
FORMATS = {"flac", "wav", "aac-hi", "mp3-320", "aiff-lossless", "vorbis", "mp3-v0", "alac"}
_SECRET = re.compile(r"(identity|session|js_logged_in|BACKENDID\d*|csrf_token)=([^;\s]+)", re.I)
LEGACY_JAR = Path.home() / "Scripts/bc-download/bandcamp-collection-downloader-master/build/libs/bandcamp-collection-downloader.jar"


class DownloadRefused(ValueError):
    pass


def find_jar(settings) -> Path:
    configured = settings.get("downloader_jar")
    candidates = [Path(configured).expanduser()] if configured else []
    candidates += [
        Path(settings.get("downloader_dir")).expanduser() / "build/libs/bandcamp-collection-downloader.jar",
        LEGACY_JAR,
    ]
    for c in candidates:
        if c.is_file():
            return c
    raise DownloadRefused(
        "downloader jar not found; build it with `./gradlew fatJar` in bandcamp-collection-downloader"
    )


def build_command(settings, string_filter: str, number: int = 1, audio_format: str = "aiff-lossless") -> list[str]:
    string_filter = (string_filter or "").strip()
    if not string_filter or string_filter == "*":
        raise DownloadRefused("a string filter is required (never download the whole collection)")
    if not 1 <= int(number) <= MAX_ITEMS:
        raise DownloadRefused(f"number must be between 1 and {MAX_ITEMS}")
    if audio_format not in FORMATS:
        raise DownloadRefused(f"unknown audio format {audio_format}")
    folder = resolve(settings.get("downloads_dir"))
    if is_within(folder, PROTECTED_VOLUME) or not is_within(folder, TEST_OWNED_ROOT):
        raise DownloadRefused(f"downloads must go into {TEST_OWNED_ROOT}, not {folder}")
    cookies = Path(settings.get("cookies_file")).expanduser()
    if not cookies.is_file():
        raise DownloadRefused(f"cookies file not found: {cookies}")
    return [
        "java", "-jar", str(find_jar(settings)),
        f"--download-folder={folder}",
        f"--audio-format={audio_format}",
        f"--string-filter={string_filter}",
        f"--number={int(number)}",
        "--skip-hidden",
        "--jobs=1",
        f"--cookies-file={cookies}",
        settings.get("bandcamp_username"),
    ]


def redact(line: str) -> str:
    return _SECRET.sub(lambda m: f"{m.group(1)}=<redacted>", line)


def run(settings, string_filter: str, number: int = 1, audio_format: str = "aiff-lossless",
        dry_run: bool = False, progress=None) -> dict[str, Any]:
    cmd = build_command(settings, string_filter, number, audio_format)
    folder = Path(cmd[3].split("=", 1)[1])
    shown = [c if not c.startswith("--cookies-file=") else "--cookies-file=<cookies file>" for c in cmd]
    if dry_run:
        return {"dry_run": True, "command": shown, "folder": str(folder)}
    folder.mkdir(parents=True, exist_ok=True)
    before = {p for p in folder.rglob("*") if p.is_file()}
    lines: list[str] = []
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = redact(raw.rstrip())
        lines.append(line)
        if progress:
            progress(len(lines), 0, line[-200:])
    code = proc.wait()
    new_files = sorted(str(p) for p in folder.rglob("*") if p.is_file() and p not in before)
    # The downloader exits 0 even when it gives up ("ERROR: Could not perform task ...").
    errors = [line for line in lines if line.startswith("ERROR")]
    return {
        "dry_run": False,
        "command": shown,
        "exit_code": code,
        "ok": code == 0 and not errors,
        "errors": errors,
        "new_files": new_files,
        "log_tail": lines[-40:],
    }


# -- CLI ---------------------------------------------------------------------------------------


def _cmd_download(svc, args: argparse.Namespace) -> int:
    try:
        result = run(svc.settings, args.filter, args.number, args.format, dry_run=args.dry_run,
                     progress=lambda n, t, line: print(line))
    except DownloadRefused as e:
        print(f"refused: {e}")
        return 2
    if args.dry_run:
        print(" ".join(result["command"]))
        return 0
    print(json.dumps({k: v for k, v in result.items() if k != "log_tail"}, indent=2) if args.json
          else f"{'ok' if result['ok'] else 'FAILED'}: exit {result['exit_code']}, "
               f"{len(result['new_files'])} new files {'; '.join(result['errors'])}")
    return 0 if result["ok"] else 1


def add_cli(sub) -> None:
    p = sub.add_parser("download", help=f"download up to {MAX_ITEMS} owned releases into test-downloads/")
    p.add_argument("--filter", required=True, help="substring of artist or album title (';' separates several)")
    p.add_argument("-n", "--number", type=int, default=1)
    p.add_argument("--format", default="aiff-lossless", choices=sorted(FORMATS))
    p.add_argument("--dry-run", action="store_true", help="print the command only")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_download)
