"""Wrapper around bandcamp-collection-downloader (the user's Kotlin tool).

* Exact releases (Phase 4, ``run_releases``): ``--item-id a<id>|t<id>`` for each release downloads exactly
  those collection items in one run (one walk of the collection), ``download_parallel`` at a time (``--jobs``),
  with ``download_timeout_s`` as the tool's ``--timeout``, respecting the tool's cache unless ``force``, into
  ``downloads_dir`` (default: the owned root; refused unless inside an owned root). Bandcamp's bot check or a
  rate limit in the output, or the drive going away, ends the run at once. Only on the user's click; agents and
  tests use ``test-downloads/`` or a stub (``BC_TAGGER_DOWNLOADER_STUB=<script>``).
* Filtered sets (A7, CLI, agents): a non-wildcard ``--string-filter``, at most ``MAX_ITEMS``
  releases, only into ``test-downloads/``.

The downloader writes ``<folder>/<artist>/<year> - <release>/``. Requests carry the app's own
User-Agent (``--user-agent``); cookie values never appear in logs or output.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from . import USER_AGENT
from .config import PROTECTED_VOLUME, TEST_OWNED_ROOT
from .fetcher import is_challenge
from .fsguard import NotMounted, ensure_dir_under, require_existing_root
from .rbguard import is_within, resolve

MAX_ITEMS = 5
DRIVE_CHECK_S = 1.0  # a run checks this often that the downloads drive is still there
KILL_AFTER_S = 10.0  # a stopped run that hasn't ended after SIGTERM gets SIGKILL
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


def _downloads_root(settings) -> tuple[Path, Path]:
    """(``downloads_dir``, the owned root it's in); refused unless inside an owned root that exists on a
    mounted volume ("music drive not mounted")."""
    folder = resolve((settings.get("downloads_dir") or "").strip() or settings.get("owned_root"))
    owned = owned_roots(settings)
    root = next((o for o in sorted(owned, key=lambda o: -len(str(o))) if is_within(folder, o)), None)
    if root is None:
        raise DownloadRefused(f"downloads_dir must be inside an owned root ({', '.join(map(str, owned))}), not {folder}")
    try:
        require_existing_root(root)
    except NotMounted as e:
        raise DownloadRefused(str(e)) from None
    return folder, root


def downloads_dir(settings) -> Path:
    """``downloads_dir``, or the owned root when empty (see ``_downloads_root``)."""
    return _downloads_root(settings)[0]


def _launcher(settings) -> list[str]:
    stub = os.environ.get(STUB_ENV)
    if stub:
        return [sys.executable, stub]
    return ["java", "-jar", str(find_jar(settings))]


def release_command(settings, release_ids: str | list[str], audio_format: str = "aiff-lossless",
                    force: bool = False, jobs: int | None = None) -> list[str]:
    """One downloader run for exact releases: ``--item-id`` for each, ``--jobs`` parallel downloads
    (``download_parallel``, at most one per release) and ``--timeout`` (``download_timeout_s``)."""
    ids = [release_ids] if isinstance(release_ids, str) else list(release_ids)
    if not ids or not all(re.fullmatch(r"[at]\d+", i or "") for i in ids):
        raise DownloadRefused(f"not release ids: {ids!r}")
    if audio_format not in FORMATS:
        raise DownloadRefused(f"unknown audio format {audio_format}")
    folder = downloads_dir(settings)
    cookies = Path(settings.get("cookies_file")).expanduser()
    if not cookies.is_file():
        raise DownloadRefused(f"cookies file not found: {cookies}")
    jobs = max(1, min(int(jobs or settings.get("download_parallel")), len(ids)))
    timeout_ms = int(float(settings.get("download_timeout_s")) * 1000)
    return [
        *_launcher(settings),
        f"--download-folder={folder}",
        f"--audio-format={audio_format}",
        *(f"--item-id={i}" for i in ids),
        "--skip-hidden",
        f"--jobs={jobs}",
        f"--timeout={timeout_ms}",
        f"--user-agent={USER_AGENT}",
        *(["--force"] if force else []),
        f"--cookies-file={cookies}",
        settings.get("bandcamp_username"),
    ]


_THREAD = re.compile(r"^\[([^\]]+)\]\s+(.*)$")  # parallel runs: "[pool-1-thread-2] <message>"
_PROGRESSES = re.compile(r"^Progress(?:es)?:\s*(.*)$")
_ONE_PROGRESS = re.compile(r"(?:\[([^\]]+)\]\s*)?([\d.,]+)\s*%")
_TRY_ERROR = re.compile(r'Error while trying: "(.*)"\.?\s*$')
_RETRY = re.compile(r"Retrying \((\d+)/(\d+)\)")
_FOUND = re.compile(r'Found release "(.*)" \((\d{4})\) by (.*) \(Bandcamp ID: [^)]*\)\.?\s*$')
_NOT_IN = re.compile(r"Not in the collection: (.*)$")
_RATE_LIMIT = re.compile(r"Status=429|HTTP 429|Too Many Requests")


def _short_error(error: str | None) -> str:
    """The retry reason in plain words: "read timed out", "HTTP 503", else the exception without its package."""
    text = (error or "an error").strip()
    if m := re.search(r"HTTP (?:code|error)[^\d]*(\d{3})|Status=(\d{3})", text):
        return f"HTTP {m.group(1) or m.group(2)}"
    if re.search(r"SocketTimeoutException", text):
        return (re.sub(r"^.*?SocketTimeoutException:?\s*", "", text) or "timed out").lower()
    if re.search(r"UnknownHostException|ConnectException|NoRouteToHost", text):
        return "no connection: " + re.sub(r"^(?:[a-z_][a-z0-9_]*\.)+", "", text)[:120]
    return re.sub(r"^(?:[a-z_][a-z0-9_]*\.)+", "", text)[:160]


def _norm(s: str | None) -> str:
    return re.sub(r"[^0-9a-z]+", " ", (s or "").lower()).strip()


def _match_release(title: str, artist: str, releases: list[dict], taken: set[str]) -> str | None:
    """Which of our releases the tool's "Found release" line is about (by title, then artist)."""
    free = [r for r in releases if r["release"] not in taken]
    same = [r for r in free if _norm(r.get("title")) == _norm(title)]
    if len(same) > 1:
        same = [r for r in same if _norm(r.get("artist")) == _norm(artist)] or same
    if same:
        return same[0]["release"]
    return free[0]["release"] if len(free) == 1 else None


def run_releases(settings, releases: list[dict], audio_format: str = "aiff-lossless", force: bool = False,
                 on_line: Callable[..., None] | None = None, jobs: int | None = None,
                 on_done: Callable[[dict], None] | None = None) -> dict[str, Any]:
    """Download several releases in one downloader run, ``download_parallel`` at a time. ``releases``:
    ``[{release, title, artist}]`` (the title tells the tool's output lines apart). Returns ``{"releases":
    {release: {outcome, ok, folder, files, errors, retries}}, "stopped", "stop_error", "exit_code", "log_tail"}``;
    ``outcome``: downloaded | on_disk | cached | not_in_collection | challenged | rate_limited | failed, or
    unmatched (the output named a release we couldn't tie to this one; ``folders`` lists every release folder
    written). ``on_line(release, message, percent)`` gets each release's progress in plain words (``release`` is
    None for lines about the whole run): its percentage, and on a retry the reason. ``on_done(result)`` gets a
    release's result as soon as the output says it finished (downloaded, on disk, failed, not in the collection)
    while the run goes on; it's called on the thread reading the tool's output, so it must be quick.
    Bandcamp's bot check or a rate limit in the output, or the downloads drive going away, ends the run at once
    (``stopped``: challenged | rate_limited | not_mounted, with the drive's message in ``stop_error``); releases
    not finished by then get that outcome (failed, for the drive)."""
    ids = [r["release"] for r in releases]
    cmd = release_command(settings, ids, audio_format, force, jobs)
    target, root = _downloads_root(settings)  # again: the drive may have gone since the job started
    try:
        ensure_dir_under(target, root)  # the tool creates artist/release folders below it
    except NotMounted as e:
        raise DownloadRefused(str(e)) from None
    say = on_line or (lambda release, message, percent=None: None)
    state = {i: {"outcome": None, "folder": None, "errors": [], "retries": [], "percent": None, "last_error": None,
                 "reported": False} for i in ids}
    thread_release: dict[str, str | None] = {}
    taken: set[str] = set()
    unmatched = 0  # "Found release" lines we couldn't tie to one of ours
    folders: list[str] = []
    stray_errors: list[str] = []  # errors on those releases' lines
    lines: list[str] = []
    stopped: dict[str, Any] = {}
    stop_lock, ended = threading.Lock(), threading.Event()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert proc.stdout is not None

    def stop(why: str, error: str | None = None) -> None:
        with stop_lock:
            if not stopped:
                stopped.update(why=why, error=error, at=time.monotonic())
                proc.terminate()

    def guard() -> None:  # the drive's still there; a stopped run that won't end is killed
        while not ended.wait(DRIVE_CHECK_S):
            if stopped:
                if time.monotonic() - stopped["at"] > KILL_AFTER_S:
                    proc.kill()
                    return
                continue
            try:
                require_existing_root(root)
            except NotMounted as e:
                stop("not_mounted", str(e))

    def result(i: str, outcome: str) -> dict[str, Any]:
        st = state[i]
        folder = st["folder"]
        files = sorted(str(p) for p in Path(folder).rglob("*") if p.is_file() and not p.name.startswith(".")) \
            if folder and Path(folder).is_dir() else []
        return {"release": i, "outcome": outcome, "ok": outcome in ("downloaded", "on_disk", "cached"),
                "folder": folder, "files": files, "errors": st["errors"][-5:], "retries": st["retries"]}

    def finished(i: str, outcome: str) -> None:
        st = state[i]
        st["outcome"] = outcome
        if on_done and not st["reported"]:
            st["reported"] = True
            on_done(result(i, outcome))

    threading.Thread(target=guard, name="downloader-guard", daemon=True).start()
    try:
        for raw in proc.stdout:  # text mode: the tool's "\r" progress updates arrive as lines too
            line = redact(raw.strip())
            if not line:
                continue
            progress = _PROGRESSES.match(line)
            if progress:  # thousands of these: report whole percents per release, don't keep them
                for part in progress.group(1).split("||"):
                    m = _ONE_PROGRESS.search(part)
                    rel = thread_release.get(m.group(1) or "main") if m else None
                    if m and rel:
                        p, st = float(m.group(2).replace(",", ".")), state[rel]
                        if st["percent"] is None or int(p) > int(st["percent"]):
                            st["percent"] = p
                            say(rel, f"downloading {int(p)} %", p)
                continue
            lines.append(line)
            if is_challenge(line) or "Client Challenge" in line:  # never retry past it: stop the run now
                stop("challenged")
            elif _RATE_LIMIT.search(line):
                stop("rate_limited")
            m = _THREAD.match(line)
            thread, msg = (m.group(1), m.group(2)) if m else ("main", line)
            if (found := _FOUND.search(msg)) is not None:
                rel = _match_release(found.group(1), found.group(3), releases, taken)
                thread_release[thread] = rel
                if rel:
                    taken.add(rel)
                else:
                    unmatched += 1
                continue
            if "Release folder: " in msg:
                folders.append(msg.split("Release folder: ", 1)[1].strip())
            if msg.startswith("Managing item"):
                thread_release[thread] = None  # the next "Found release" says which
                continue
            if (gone := _NOT_IN.search(msg)) is not None:
                for i in re.split(r"[,\s]+", gone.group(1)):
                    if i in state:
                        finished(i, "not_in_collection")
                continue
            rel = thread_release.get(thread)
            st = state.get(rel) if rel else None
            if st is None:
                if msg.startswith("Could not download item") or _TRY_ERROR.search(msg):
                    stray_errors.append(msg)
                say(None, msg[-200:], None)
                continue
            if "Release folder: " in msg:
                st["folder"] = msg.split("Release folder: ", 1)[1].strip()
            if (e := _TRY_ERROR.search(msg)) is not None:
                st["last_error"] = e.group(1)
                st["retries"].append(_short_error(e.group(1)))
                say(rel, f"Bandcamp error: {_short_error(e.group(1))}", st["percent"])
            elif (r := _RETRY.search(msg)) is not None:
                st["percent"] = None
                say(rel, f"retry {r.group(1)}/{r.group(2)}: {_short_error(st['last_error'])}", None)
            elif "Starting the download of" in msg:
                say(rel, "downloading…", None)
            elif "successfully downloaded" in msg:
                say(rel, "downloaded; unpacking done", 100.0)
                finished(rel, "downloaded")
            elif "already exists on disk" in msg:
                finished(rel, "on_disk")
            elif msg.startswith("Could not download item") or "is a preorder; skipping" in msg:
                st["errors"].append(msg)
                say(rel, msg[-200:], st["percent"])
                finished(rel, "failed")
            else:
                say(rel, msg[-200:], st["percent"])
        code = proc.wait()
    finally:
        ended.set()
        if proc.poll() is None:  # the reader failed (on_done or on_line raised): don't leave the tool running
            proc.kill()
            proc.wait()
    text = "\n".join(lines)
    run_outcome = stopped.get("why")
    if run_outcome is None and "None of the requested items are in the collection" in text:
        run_outcome = "not_in_collection"
    ignored = re.search(r"Ignoring \d+ already downloaded items", text) is not None
    out: dict[str, dict[str, Any]] = {}
    for i in ids:
        st = state[i]
        outcome = st["outcome"]
        if outcome is None and i not in taken and not run_outcome and unmatched:
            outcome = "unmatched"  # some release we couldn't tell apart: the caller checks its files
        if outcome is None and run_outcome == "not_mounted":
            outcome = "failed"
            st["errors"].append(stopped["error"])
        if outcome is None:
            outcome = run_outcome or ("cached" if ignored and i not in taken else "failed")
        if outcome == "failed" and not st["errors"]:
            st["errors"] = [ln for ln in lines if "ERROR" in ln][-3:]
        out[i] = result(i, outcome)
    return {"releases": out, "folders": folders, "stray_errors": stray_errors[-5:], "stopped": stopped.get("why"),
            "stop_error": stopped.get("error"), "exit_code": code, "log_tail": lines[-20:]}


def run_release(settings, release_id: str, audio_format: str = "aiff-lossless", force: bool = False,
                on_line: Callable[..., None] | None = None, title: str | None = None) -> dict[str, Any]:
    """One release (see ``run_releases``); ``on_line(message, percent)``."""
    say = on_line or (lambda message, percent=None: None)
    run = run_releases(settings, [{"release": release_id, "title": title}], audio_format, force,
                       lambda release, message, percent=None: say(message, percent), jobs=1)
    return {**run["releases"][release_id], "exit_code": run["exit_code"], "log_tail": run["log_tail"]}


def redact(line: str) -> str:
    return _SECRET.sub(lambda m: f"{m.group(1)}=<redacted>", line)


def run(settings, string_filter: str, number: int = 1, audio_format: str = "aiff-lossless",
        dry_run: bool = False, progress=None) -> dict[str, Any]:
    cmd = build_command(settings, string_filter, number, audio_format)
    folder = Path(cmd[3].split("=", 1)[1])
    shown = [c if not c.startswith("--cookies-file=") else "--cookies-file=<cookies file>" for c in cmd]
    if dry_run:
        return {"dry_run": True, "command": shown, "folder": str(folder)}
    try:
        ensure_dir_under(folder, TEST_OWNED_ROOT)
    except NotMounted as e:
        raise DownloadRefused(str(e)) from None
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
