"""A stand-in for bandcamp-collection-downloader (tests and e2e; never the network).

Run by the server instead of the jar when ``BC_TAGGER_DOWNLOADER_STUB=<this file>``. Like the tool,
``--string-filter`` keeps the collection entries whose artist or album title contains it (``;``
separates several), logs ``Matched filter: [ItemMetadata(…), …]``, then ``--number`` keeps the first
n, the cache file skips what was downloaded before (unless ``--force``), and each release is written
as ``<folder>/<artist>/<year> - <album title>/NN <track>.aiff`` with tags.

``BC_TAGGER_STUB_RELEASES=<json file>``: the collection in order, ``[{"sale_item_id", "artist",
"album_title", "year", "tracks": [..], "fail": "challenge"|"rate_limit"|"error"}]``.
``BC_TAGGER_STUB_DELAY=<seconds>``: wait that long before writing (to see progress in a UI).
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
    p.add_argument("--string-filter", default="*")
    p.add_argument("--number", type=int, default=2**31 - 1)
    p.add_argument("--force", action="store_true")
    p.add_argument("--cookies-file")
    args, rest = p.parse_known_args()
    collection = []
    if os.environ.get("BC_TAGGER_STUB_RELEASES"):
        collection = json.loads(Path(os.environ["BC_TAGGER_STUB_RELEASES"]).read_text())
    folder = Path(args.download_folder)
    log(f"Target bandcamp account: {rest[-1] if rest else '?'}")
    log(f"Target download folder: {folder}")
    log(f"Name filter {args.string_filter}. To download {args.number} items")
    if any(e.get("fail") == "challenge" for e in collection):
        log("<!DOCTYPE html><html><head><title>Client Challenge</title></head></html>")
        print("ERROR: Could not perform task", file=sys.stderr, flush=True)
        return 0
    if any(e.get("fail") == "rate_limit" for e in collection):
        print("ERROR: HTTP error fetching URL. Status=429", file=sys.stderr, flush=True)
        return 0
    filters = [f.strip().lower() for f in args.string_filter.split(";")]
    matched = collection if args.string_filter in ("*", "") else [
        e for e in collection if any(f in e["artist"].lower() or f in e["album_title"].lower() for f in filters)]
    log("Matched filter: [" + ", ".join(f"ItemMetadata(sale_item_id={e['sale_item_id']}, band_name={e['artist']}, "
                                       f"album_title={e['album_title']})" for e in matched) + "].")
    time.sleep(0.3)  # the tool goes on to fetch the download pages
    chosen = matched[:args.number]
    log(f'Found "herrasti" with {len(chosen)} items.')
    cache_file = folder / "bandcamp-collection-downloader.cache"
    cache = set(cache_file.read_text().split()) if cache_file.exists() else set()
    todo = chosen if args.force else [e for e in chosen if f"p{e['sale_item_id']}" not in cache]
    if len(chosen) - len(todo):
        log(f"Ignoring {len(chosen) - len(todo)} already downloaded items (based on '{cache_file}').")
    for n, e in enumerate(todo, 1):
        log(f"Managing item {n}/{len(todo)}")
        name = f'"{e["album_title"]}" ({e["year"]}) by {e["artist"]}'
        log(f"Found release {name} (Bandcamp ID: p{e['sale_item_id']}).")
        if e.get("fail") == "error":
            log("Could not download item: No URL found for item")
            continue
        release_folder = folder / e["artist"] / f'{e["year"]} - {e["album_title"]}'
        log(f"Starting the download of {name}.")
        time.sleep(float(os.environ.get("BC_TAGGER_STUB_DELAY", "0")))
        if release_folder.exists() and not args.force:
            log(f"{name} already exists on disk, skipping.")
        else:
            release_folder.mkdir(parents=True, exist_ok=True)
            for i, track in enumerate(e["tracks"], 1):
                write_aiff(release_folder / f"{i:02d} {track}.aiff", track, e["artist"], e["album_title"], i)
            log(f"{name} successfully downloaded.")
        with cache_file.open("a") as f:
            f.write(f"p{e['sale_item_id']}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
