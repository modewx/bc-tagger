"""A stand-in for bandcamp-collection-downloader with ``--item-id`` (tests and e2e; never the network).

Run by the server instead of the jar when ``BC_TAGGER_DOWNLOADER_STUB=<this file>``. It prints the
jar's lines and writes ``<folder>/<artist>/<year> - <title>/NN <track>.aiff`` with tags.

``BC_TAGGER_STUB_RELEASES=<json file>``: ``{"a123": {"artist", "title", "year", "tracks": [..],
"fail": "not_in_collection"|"challenge"|"rate_limit"|"error"}}``; unknown ids get a generic release.
``BC_TAGGER_STUB_DELAY=<seconds>``: wait that long before writing (to see progress in a UI).
``BC_TAGGER_STUB_RETRY=1``: the first download attempt fails and is retried, like the tool's retries.
Download progress is printed like the tool does: "Progress: 42.00 %" ending in "\r", no newline.
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


def log(line: str) -> None:
    print(line, flush=True)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--download-folder", required=True)
    p.add_argument("--audio-format", default="vorbis")
    p.add_argument("--item-id", action="append", default=[])
    p.add_argument("--user-agent")
    p.add_argument("--force", action="store_true")
    p.add_argument("--cookies-file")
    args, rest = p.parse_known_args()
    releases = {}
    if os.environ.get("BC_TAGGER_STUB_RELEASES"):
        releases = json.loads(Path(os.environ["BC_TAGGER_STUB_RELEASES"]).read_text())
    folder = Path(args.download_folder)
    log(f"Target bandcamp account: {rest[-1] if rest else '?'}")
    log(f"Target download folder: {folder}")
    log(f"User-Agent: {args.user_agent}")
    ids = [i for raw in args.item_id for i in raw.split(",") if i]
    log(f"Items: {', '.join(ids)}")
    cache_file = folder / "bandcamp-collection-downloader.cache"
    cache = set(cache_file.read_text().split()) if cache_file.exists() else set()
    for item_id in ids:
        rel = {"artist": "Stub Artist", "title": f"Stub Release {item_id}", "year": 2026, "tracks": ["Stub Track"],
               **releases.get(item_id, {})}
        fail = rel.get("fail")
        if fail == "not_in_collection":
            log(f"Not in the collection: {item_id}")
            print(f"ERROR: None of the requested items are in the collection: {item_id}", file=sys.stderr, flush=True)
            return 0
        if fail == "challenge":
            log("<!DOCTYPE html><html><head><title>Client Challenge</title></head></html>")
            print("ERROR: Could not perform task", file=sys.stderr, flush=True)
            return 0
        if fail == "rate_limit":
            print("ERROR: HTTP error fetching URL. Status=429", file=sys.stderr, flush=True)
            return 0
        sale_id = "p" + item_id[1:]
        if sale_id in cache and not args.force:
            log(f"Ignoring 1 already downloaded items (based on '{cache_file}').")
            return 0
        name = f'"{rel["title"]}" ({rel["year"]}) by {rel["artist"]}'
        log(f"Found release {name} (Bandcamp ID: {sale_id}).")
        if fail == "error":
            log("Could not download item: No URL found for item")
            return 0
        release_folder = folder / rel["artist"] / f'{rel["year"]} - {rel["title"]}'
        log(f"Starting the download of {name}.")
        log(f"Release folder: {release_folder}")
        if os.environ.get("BC_TAGGER_STUB_RETRY"):
            log('Error while trying: "java.net.SocketTimeoutException: Read timed out".')
            log("Retrying (1/3).")
        for pct in (0, 12.5, 12.9, 50, 99.99):
            print(f"Progress: {pct:.2f} %" + " " * 20 + "\r", end="", flush=True)
        time.sleep(float(os.environ.get("BC_TAGGER_STUB_DELAY", "0")))
        if release_folder.exists() and not args.force:
            log(f"{name} already exists on disk, skipping.")
        else:
            release_folder.mkdir(parents=True, exist_ok=True)
            for n, track in enumerate(rel["tracks"], 1):
                write_aiff(release_folder / f"{n:02d} {track}.aiff", track, rel["artist"], rel["title"], n)
            log(f"{name} successfully downloaded.")
        if sale_id not in cache:
            with cache_file.open("a") as f:
                f.write(sale_id + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
