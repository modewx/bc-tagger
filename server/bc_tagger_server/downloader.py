"""Wrapper around bandcamp-collection-downloader (the user's Kotlin tool).

* One release (Phase 4, ``run_release``): ``--string-filter=<its exact title> --number=1``, the tool's
  cache respected unless ``force``, into ``downloads_dir`` (default: the owned root; refused unless
  inside an owned root). Generic or short titles are refused, and a run whose first match isn't that
  exact title is stopped before it downloads. Only on the user's click; agents and tests use
  ``test-downloads/`` or a stub (``BC_TAGGER_DOWNLOADER_STUB=<script>``). (An exact ``--item-id`` option
  is on the plan's Later list.)
* Filtered sets (A7, CLI, agents): a non-wildcard ``--string-filter``, at most ``MAX_ITEMS``
  releases, only into ``test-downloads/``.

The downloader writes ``<folder>/<artist>/<year> - <release>/``. Cookie values never appear in logs
or output.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

from .config import PROTECTED_VOLUME, TEST_OWNED_ROOT
from .fetcher import is_challenge
from .rbguard import is_within, resolve

MAX_ITEMS = 5
FORMATS = {"flac", "wav", "aac-hi", "mp3-320", "aiff-lossless", "vorbis", "mp3-v0", "alac"}
_SECRET = re.compile(r"(identity|session|js_logged_in|BACKENDID\d*|csrf_token)=([^;\s]+)", re.I)
LEGACY_JAR = Path.home() / "Scripts/bc-download/bandcamp-collection-downloader-master/build/libs/bandcamp-collection-downloader.jar"
STUB_ENV = "BC_TAGGER_DOWNLOADER_STUB"  # a stub script run with this Python instead of the jar (tests, e2e)


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
    folder = resolve(settings.get("downloads_dir") or TEST_OWNED_ROOT)  # agents: test-downloads only
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


def owned_roots(settings) -> list[Path]:
    return [resolve(r["path"]) for r in settings.roots() if r["kind"] == "owned"]


def downloads_dir(settings) -> Path:
    """``downloads_dir``, or the owned root when empty; refused unless inside an owned root."""
    folder = resolve((settings.get("downloads_dir") or "").strip() or settings.get("owned_root"))
    owned = owned_roots(settings)
    if not any(is_within(folder, o) for o in owned):
        raise DownloadRefused(f"downloads_dir must be inside an owned root ({', '.join(map(str, owned))}), not {folder}")
    return folder


def _launcher(settings) -> list[str]:
    stub = os.environ.get(STUB_ENV)
    if stub:
        return [sys.executable, stub]
    return ["java", "-jar", str(find_jar(settings))]


# Titles that would match far more than one release by substring.
_GENERIC = re.compile(r"^(untitled|ep|lp|e\.p\.|l\.p\.|single|album|demo|demos|live|mix|remix|remixes|edits|"
                      r"(vol|volume|part|pt|track|chapter|side)\.?\s*[\divx]+)$", re.I)


def norm_title(s: str | None) -> str:
    return " ".join((s or "").casefold().split())


def check_filter(title: str | None) -> str:
    """The release's exact title as the downloader's ``--string-filter``, or why it can't be one."""
    t = " ".join((title or "").split())
    if not t:
        raise DownloadRefused("the release has no title to filter by")
    if ";" in t or "*" in t:
        raise DownloadRefused(f'"{t}" contains ";" or "*", which the downloader reads as several filters')
    if len(t) < 5:
        raise DownloadRefused(f'"{t}" is shorter than 5 characters: it would match other releases')
    if re.fullmatch(r"[\d\W_]+", t):
        raise DownloadRefused(f'"{t}" is only digits: it would match other releases')
    if _GENERIC.match(t):
        raise DownloadRefused(f'"{t}" is too generic: it would match other releases')
    return t


def release_command(settings, string_filter: str, audio_format: str = "aiff-lossless", force: bool = False) -> list[str]:
    """One release by its exact title: ``--string-filter`` (substring of album title or artist, the
    tool's cache respected unless ``--force``) capped with ``--number=1`` (applied after the filter)."""
    string_filter = check_filter(string_filter)
    if audio_format not in FORMATS:
        raise DownloadRefused(f"unknown audio format {audio_format}")
    folder = downloads_dir(settings)
    cookies = Path(settings.get("cookies_file")).expanduser()
    if not cookies.is_file():
        raise DownloadRefused(f"cookies file not found: {cookies}")
    return [
        *_launcher(settings),
        f"--download-folder={folder}",
        f"--audio-format={audio_format}",
        f"--string-filter={string_filter}",
        "--number=1",
        "--skip-hidden",
        "--jobs=1",
        *(["--force"] if force else []),
        f"--cookies-file={cookies}",
        settings.get("bandcamp_username"),
    ]


_MATCH = re.compile(r"ItemMetadata\(sale_item_id=(\d+), band_name=(.*?), album_title=(.*?)\)(?=, ItemMetadata\(|\]\.?\s*$)")


def parse_matches(line: str) -> list[dict[str, str]]:
    """The tool's ``Matched filter: [ItemMetadata(sale_item_id=…, band_name=…, album_title=…), …]``."""
    body = line.split("Matched filter:", 1)[1].strip()
    return [{"sale_item_id": m.group(1), "artist": m.group(2), "album_title": m.group(3)} for m in _MATCH.finditer(body)]


def run_release(settings, string_filter: str, audio_format: str = "aiff-lossless", force: bool = False,
                on_line: Callable[[str], None] | None = None) -> dict[str, Any]:
    """Download one release by its exact title. The tool logs what the filter matched before it
    downloads anything: unless the first match (the one ``--number=1`` keeps) has exactly this title, the
    run is stopped there (``outcome: "ambiguous"``). ``outcome``: downloaded | on_disk | cached |
    not_in_collection | ambiguous | challenged | rate_limited | failed."""
    cmd = release_command(settings, string_filter, audio_format, force)
    wanted = norm_title(string_filter)
    lines: list[str] = []
    matched: list[dict[str, str]] | None = None
    stopped = None
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = redact(raw.rstrip())
        lines.append(line)
        if on_line:
            on_line(line[-200:])
        if matched is None and "Matched filter:" in line:
            matched = parse_matches(line)
            if matched and norm_title(matched[0]["album_title"]) != wanted:
                stopped = matched[0]
                proc.terminate()  # before it downloads the wrong release
                break
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    code = proc.returncode
    text = "\n".join(lines)
    errors = [ln for ln in lines if "ERROR" in ln or "Could not download item" in ln]
    if stopped is not None:
        outcome = "ambiguous"
        errors.append(f'the filter would download "{stopped["album_title"]}" by {stopped["artist"]} first')
    elif is_challenge(text) or "Client Challenge" in text:
        outcome = "challenged"
    elif re.search(r"Status=429|HTTP 429|Too Many Requests", text):
        outcome = "rate_limited"
    elif matched == []:
        outcome = "not_in_collection"
    elif "successfully downloaded" in text:
        outcome = "downloaded"
    elif "already exists on disk" in text:
        outcome = "on_disk"
    elif re.search(r"Ignoring \d+ already downloaded items", text) and "Found release" not in text:
        outcome = "cached"
    else:
        outcome = "failed"
    found = next((m.group(0) for ln in lines for m in [re.search(r'Found release ".*', ln)] if m), None)
    return {"filter": string_filter, "outcome": outcome, "ok": outcome in ("downloaded", "on_disk", "cached"),
            "exit_code": code, "matched": (matched or [])[:5], "matched_count": len(matched or []),
            "found": found, "errors": errors[-5:], "log_tail": lines[-20:]}


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
