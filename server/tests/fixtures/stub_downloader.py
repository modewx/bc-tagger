"""A stand-in for bandcamp-collection-downloader with ``--item-id`` (tests and e2e; never the network).

Run by the server instead of the jar when ``BC_TAGGER_DOWNLOADER_STUB=<this file>``. It prints the
jar's lines and writes ``<folder>/<artist>/<year> - <title>/NN <track>.aiff`` with tags.

``BC_TAGGER_STUB_RELEASES=<json file>``: ``{"a123": {"artist", "title", "year", "tracks": [..],
"fail": "not_in_collection"|"challenge"|"rate_limit"|"error", "retry_error": "<exception text>", "retry_wait": s}}``;
unknown ids get a generic release. ``retry_error``: that release's first attempt fails with it part way and is
retried; ``retry_wait``: seconds to wait after "Retrying (1/3)." (the other releases have started by then).
``BC_TAGGER_STUB_DELAY=<seconds>``: wait that long before writing (to see progress in a UI).
``BC_TAGGER_STUB_RETRY=1``: every release's first attempt fails ("Read timed out") and is retried.
``BC_TAGGER_STUB_ARGS=<file>``: append each run's arguments there (one JSON list per line).
``fail: "challenge"`` / ``"rate_limit"`` print Bandcamp's bot check / a 429 when that release's turn comes (the
releases before it download), then wait ``BC_TAGGER_STUB_AFTER_STOP`` seconds (default 2) and carry on like a
tool that didn't notice: the server must end the run itself, so nothing after it gets written.
Download progress is printed like the tool does: "Progress: 42.00 %" ending in "\r", no newline. With
``--jobs`` > 1 the releases run "in parallel" like the tool's threads: each line starts with
"[pool-1-thread-N] ", and progress reads "Progresses: [pool-1-thread-1] 12.50 % || [pool-1-thread-2] …".
"""

import argparse
import json
import os
import struct
import sys
import time
from pathlib import Path


def write_aiff(path: Path, title: str, artist: str, album: str, track: int) -> None:
    rate, frames = 8000, 800
    exp, mant = 16383 + 12, rate << (63 - 12)
    comm = struct.pack(">hLh", 1, frames, 16) + struct.pack(">HQ", exp, mant)
    ssnd = struct.pack(">LL", 0, 0) + b"\x00\x00" * frames
    body = b"AIFF" + b"COMM" + struct.pack(">L", len(comm)) + comm + b"SSND" + struct.pack(">L", len(ssnd)) + ssnd
    path.write_bytes(b"FORM" + struct.pack(">L", len(body)) + body)
    import mutagen.aiff
    from mutagen.id3 import TALB, TIT2, TPE1, TRCK

    f = mutagen.aiff.AIFF(path)
    f.add_tags()
    for frame in (TIT2(encoding=3, text=title), TPE1(encoding=3, text=artist), TALB(encoding=3, text=album),
                  TRCK(encoding=3, text=str(track))):
        f.tags.add(frame)
    f.save()


def log(line: str, thread: str | None = None) -> None:
    print(f"[{thread}] {line}" if thread else line, flush=True)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--download-folder", required=True)
    p.add_argument("--audio-format", default="vorbis")
    p.add_argument("--item-id", action="append", default=[])
    p.add_argument("--user-agent")
    p.add_argument("--force", action="store_true")
    p.add_argument("--cookies-file")
    p.add_argument("--jobs", type=int, default=4)
    p.add_argument("--timeout", type=int, default=50000)
    args, rest = p.parse_known_args()
    if os.environ.get("BC_TAGGER_STUB_ARGS"):
        with open(os.environ["BC_TAGGER_STUB_ARGS"], "a") as f:
            f.write(json.dumps([a for a in sys.argv[1:] if not a.startswith("--cookies-file")]) + "\n")
    releases = {}
    if os.environ.get("BC_TAGGER_STUB_RELEASES"):
        releases = json.loads(Path(os.environ["BC_TAGGER_STUB_RELEASES"]).read_text())
    folder = Path(args.download_folder)
    log(f"Target bandcamp account: {rest[-1] if rest else '?'}")
    log(f"Target download folder: {folder}")
    log(f"User-Agent: {args.user_agent}")
    ids = [i for raw in args.item_id for i in raw.split(",") if i]
    log(f"Items: {', '.join(ids)}")
    rels = {i: {"artist": "Stub Artist", "title": f"Stub Release {i}", "year": 2026, "tracks": ["Stub Track"],
                **releases.get(i, {})} for i in ids}
    missing = [i for i in ids if rels[i].get("fail") == "not_in_collection"]
    if missing:
        log(f"Not in the collection: {', '.join(missing)}")
    found = [i for i in ids if i not in missing]
    if not found:
        print(f"ERROR: None of the requested items are in the collection: {', '.join(ids)}", file=sys.stderr, flush=True)
        return 0
    cache_file = folder / "bandcamp-collection-downloader.cache"
    cache = set(cache_file.read_text().split()) if cache_file.exists() else set()
    todo = [i for i in found if args.force or "p" + i[1:] not in cache]
    if len(todo) < len(found):
        log(f"Ignoring {len(found) - len(todo)} already downloaded items (based on '{cache_file}').")
    log("------------")
    jobs = max(1, args.jobs)
    for start in range(0, len(todo), jobs):  # each group runs "at the same time", one per thread
        group = todo[start:start + jobs]
        for i in [i for i in group if rels[i].get("fail") in ("challenge", "rate_limit")]:
            if rels[i]["fail"] == "challenge":
                log("<!DOCTYPE html><html><head><title>Client Challenge</title></head></html>")
            else:
                print("ERROR: HTTP error fetching URL. Status=429", file=sys.stderr, flush=True)
            time.sleep(float(os.environ.get("BC_TAGGER_STUB_AFTER_STOP", "2")))
            group.remove(i)
        thread = {i: (f"pool-1-thread-{k + 1}" if jobs > 1 else None) for k, i in enumerate(group)}
        names, folders = {}, {}
        for n, i in enumerate(group, start + 1):
            rel, t = rels[i], thread[i]
            log(f"Managing item {n}/{len(todo)}", t)
            names[i] = f'"{rel["title"]}" ({rel["year"]}) by {rel["artist"]}'
            log(f"Found release {names[i]} (Bandcamp ID: p{i[1:]}).", t)
        for i in [i for i in group if rels[i].get("fail") == "error"]:
            log("Could not download item: No URL found for item", thread[i])
            group.remove(i)
        for i in group:
            folders[i] = folder / rels[i]["artist"] / f'{rels[i]["year"]} - {rels[i]["title"]}'
            log(f"Starting the download of {names[i]}.", thread[i])
            log(f"Release folder: {folders[i]}", thread[i])
        for pct in (0, 12.5, 12.9, 50, 99.99):
            if pct == 50:  # part way: a release's first attempt fails and is retried
                waits = []
                for i in group:
                    error = rels[i].get("retry_error") or (
                        "java.net.SocketTimeoutException: Read timed out" if os.environ.get("BC_TAGGER_STUB_RETRY") else None)
                    if error:
                        log(f'Error while trying: "{error}".', thread[i])
                        log("Retrying (1/3).", thread[i])
                        waits.append(float(rels[i].get("retry_wait") or 0))
                time.sleep(max(waits, default=0))
            if jobs > 1:  # the tool's threads share one line
                line = "Progresses: " + " || ".join(f"[{thread[i]}] {pct + k:.2f} %" for k, i in enumerate(group))
            else:
                line = f"Progress: {pct:.2f} %"
            print(line + " " * 20 + "\r", end="", flush=True)
        time.sleep(float(os.environ.get("BC_TAGGER_STUB_DELAY", "0")))
        for i in group:
            rel = rels[i]
            if folders[i].exists() and not args.force:
                log(f"{names[i]} already exists on disk, skipping.", thread[i])
            else:
                folders[i].mkdir(parents=True, exist_ok=True)
                for n, track in enumerate(rel["tracks"], 1):
                    write_aiff(folders[i] / f"{n:02d} {track}.aiff", track, rel["artist"], rel["title"], n)
                log(f"{names[i]} successfully downloaded.", thread[i])
            if "p" + i[1:] not in cache:
                with cache_file.open("a") as f:
                    f.write("p" + i[1:] + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
