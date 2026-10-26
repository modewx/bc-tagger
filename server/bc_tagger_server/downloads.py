"""Download owned releases for collection items and import rows that aren't located (Phase 4).

Each ref is an item id (``t123``/``a456``) or an import row (``<batch_id>:<n>``). Tracks map to their
album when the album is owned (else the track itself if it was bought alone); releases are
deduped and downloaded one at a time (one download job at a time, too). After each release its
folder is indexed and the affected items and rows are located again. Bandcamp's bot check or a
rate limit stops the remaining releases.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from . import downloader
from .downloader import DownloadRefused
from .items import album_name
from .tagread import AUDIO_EXTS

_one_at_a_time = threading.Lock()

MESSAGES = {
    "downloaded": "downloaded",
    "on_disk": "already on disk",
    "cached": "downloaded before (the downloader's cache): nothing new; download again with force",
    "not_in_collection": "not in your Bandcamp collection",
    "challenged": "Bandcamp answered with its bot check; downloads stopped",
    "rate_limited": "Bandcamp is rate-limiting; try again later",
    "failed": "the download failed",
}


def _owned(store, ids: list[str]) -> set[str]:
    ids = [i for i in ids if i]
    if not ids:
        return set()
    marks = ",".join("?" * len(ids))
    return {r["id"] for r in store.query(f"SELECT id FROM owned_ids WHERE id IN ({marks})", ids)}


def release_for(store, item: dict) -> str | None:
    """The collection item to download for ``item``: its album if owned, else itself if owned."""
    album = item.get("album_id")
    album = f"a{album}" if isinstance(album, int) else album
    owned = _owned(store, [album if isinstance(album, str) and album.startswith("a") else None, item["id"]])
    if album in owned:
        return album
    return item["id"] if item["id"] in owned else None


def _resolve(svc, ref: str, collection: dict[str, dict]) -> dict[str, Any]:
    """``{ref, item, located, row?}`` or ``{ref, error}``."""
    from . import importer

    if ":" in ref:
        batch_id, _, n = ref.rpartition(":")
        try:
            row = next((r for r in importer.load_rows(svc.store, batch_id) if str(r["n"]) == n), None)
        except KeyError:
            row = None
        if row is None:
            return {"ref": ref, "error": "no such import row"}
        item = (row.get("bandcamp") or {}).get("item")
        if not item:
            return {"ref": ref, "error": "not a Bandcamp row: link it to its Bandcamp page first"}
        return {"ref": ref, "item": item, "row": (batch_id, row["n"]),
                "located": (row.get("located") or {}).get("status") == "located"}
    item = collection.get(ref)
    if item is None:
        return {"ref": ref, "error": "no such item"}
    if str(ref).startswith("o"):
        return {"ref": ref, "error": "not a Bandcamp item"}
    located = svc.store.query_one("SELECT status FROM locate_results WHERE item_id = ?", (ref,))
    return {"ref": ref, "item": item, "located": bool(located) and located["status"] == "located"}


def plan(svc, refs: list[str], force: bool = False) -> dict[str, Any]:
    """What a download would do: ``{destination, format, releases: [{release, refs, title, artist}], items:
    [{ref, item_id, title, artist, release, state: "queued"|"skipped"|"failed", message}]}``."""
    folder = downloader.downloads_dir(svc.settings)
    collection = {it["id"]: it for it in svc.collection_items()}
    items, releases = [], {}
    for ref in dict.fromkeys(refs):
        r = _resolve(svc, ref, collection)
        item = r.get("item") or {}
        entry = {"ref": ref, "item_id": item.get("id"), "title": item.get("title"), "artist": item.get("artist"),
                 "release": None, "state": "failed", "message": r.get("error")}
        if item:
            release = release_for(svc.store, item)
            if release is None:
                entry["message"] = "not owned"
            elif r["located"] and not force:
                entry.update(release=release, state="skipped", message="already located")
            else:
                entry.update(release=release, state="queued", message="queued")
                # an album item's album_title is a URL slug: its own title is the album's
                title = (album_name(item) if release.startswith("a") else None) or item.get("title")
                rel = releases.setdefault(release, {"release": release, "refs": [], "title": title,
                                                    "artist": item.get("artist")})
                rel["refs"].append(ref)
        items.append(entry)
    return {"destination": str(folder), "format": svc.settings.get("download_format"),
            "releases": list(releases.values()), "items": items}


def _index_folder(svc, folder: str | None) -> int:
    from .indexer import index_file

    if not folder or not Path(folder).is_dir():
        return 0
    roots = svc.settings.roots()
    n = 0
    for p in sorted(Path(folder).rglob("*")):
        if p.is_file() and p.suffix.lower() in AUDIO_EXTS and not p.name.startswith("."):
            index_file(svc.store, p, roots)
            n += 1
    return n


def _locate_refs(svc, entries: list[dict]) -> dict[str, bool]:
    from . import importer

    located: dict[str, bool] = {}
    items = [e["item_id"] for e in entries if ":" not in e["ref"]]
    if items:
        for s in svc.locate(ids=items, scan="none")["items"]:
            located[s["id"]] = s["status"] == "located"
    for e in entries:
        if ":" in e["ref"]:
            batch_id, _, n = e["ref"].rpartition(":")
            batch = importer.load_batch(svc.store, batch_id)
            rows = importer.load_rows(svc.store, batch_id)
            row = next(r for r in rows if str(r["n"]) == n)
            importer._locate(svc, [row])
            importer._save_rows(svc.store, batch_id, [row])
            importer._refresh_stats(svc.store, batch, rows)
            importer._row_event(svc, batch_id, row["n"], len(rows))
            located[e["ref"]] = row["located"]["status"] == "located"
        else:
            located[e["ref"]] = located.get(e["item_id"], False)
    return located


def run(svc, refs: list[str], force: bool = False, ctx=None) -> dict[str, Any]:
    p = plan(svc, refs, force)
    job_id = ctx.job.id if ctx else None
    by_ref = {e["ref"]: e for e in p["items"]}

    def publish(entry: dict) -> None:
        svc.jobs.bus.publish("download", {"job_id": job_id, **{k: entry.get(k) for k in (
            "ref", "item_id", "release", "state", "message", "located")}})

    for e in p["items"]:
        publish(e)
    results = []
    stop = None
    with _one_at_a_time:
        for i, rel in enumerate(p["releases"], 1):
            entries = [by_ref[r] for r in rel["refs"]]
            if stop:
                for e in entries:
                    e.update(state="failed", message=stop)
                    publish(e)
                continue
            for e in entries:
                e.update(state="downloading", message=f"downloading {rel['title'] or rel['release']}")
                publish(e)
            if ctx:
                ctx.progress(i - 1, len(p["releases"]), f"downloading {i}/{len(p['releases'])}: {rel['title']}")
            try:
                res = downloader.run_release(svc.settings, rel["release"], p["format"], force,
                                             on_line=lambda line: ctx.progress(i - 1, len(p["releases"]), line) if ctx else None)
            except (DownloadRefused, OSError) as err:
                res = {"release": rel["release"], "outcome": "failed", "ok": False, "folder": None, "files": [],
                       "errors": [str(err)]}
            if res["outcome"] in ("challenged", "rate_limited"):
                stop = MESSAGES[res["outcome"]]
            indexed = _index_folder(svc, res.get("folder")) if res["ok"] else 0
            located = _locate_refs(svc, entries) if res["ok"] else {}
            for e in entries:
                message = MESSAGES[res["outcome"]]
                if res["outcome"] == "failed" and res.get("errors"):
                    message = f"{message}: {res['errors'][-1]}"
                e.update(state="done" if res["ok"] else "failed", message=message, located=located.get(e["ref"]))
                publish(e)
            results.append({**{k: v for k, v in res.items() if k != "log_tail"}, "indexed": indexed,
                            "refs": rel["refs"]})
    if ctx:
        ctx.progress(len(p["releases"]), len(p["releases"]), "downloads done")
    return {"destination": p["destination"], "releases": results, "items": p["items"], "stopped": stop}
