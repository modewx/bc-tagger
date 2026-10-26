"""Import logs: when an import commit finishes, fully or partly, a JSON file with everything that was
imported and a short Markdown summary beside it.

They go to ``import_log_dir`` (default ``<data dir>/import-logs``; never inside a root or on the music
drive), named ``YYYY-MM-DD_HHMMSS_<batch name>_<batch_id>.json`` / ``.md`` in local time. Writing a log
never fails the import: a problem is reported as ``log_error`` in the commit result.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import all_root_paths, import_log_dir_problem
from .fsguard import NotMounted, require_mounted
from .items import album_name
from .store import now_iso

FORMAT = "bc-tagger-import-log/1"
OUTCOMES = {"pending_add": "added_to_tagger", "tag_merge": "merged", "other": "added_to_other",
            "other_merge": "merged_into_other"}
LABELS = {
    "added_to_tagger": "added to the tagger", "merged": "merged into an existing item",
    "added_to_other": "added to other", "merged_into_other": "merged into an other item",
    "unchecked": "unchecked (skipped)", "not_imported": "not imported (the import stopped)",
}
_FILE = re.compile(r"^[\w.,()+-]+\.(json|md)$")


class LogNotFound(KeyError):
    pass


def log_dir(svc, create: bool = True) -> tuple[Path, str | None]:
    """The folder for logs and, when the setting can't be used right now, why the default is used.
    Only writing a log (or opening the folder) creates it; listing and reading don't."""
    configured = svc.settings.import_log_dir()
    default = svc.settings.path.parent / "import-logs"
    warning = None
    if configured != default:
        warning = import_log_dir_problem(configured, all_root_paths(svc.settings.all()))
        if warning is None:
            try:
                require_mounted(configured)
            except NotMounted as e:
                warning = str(e)
        if warning:
            warning, configured = f"{warning}; logs go to {default}", default
    if create:
        configured.mkdir(parents=True, exist_ok=True)
    return configured, warning


def _slug(name: str) -> str:
    name = re.sub(r"\.(json|txt|md|csv)$", "", name or "import", flags=re.I)
    name = re.sub(r"[^\w.,()+-]+", "-", name).strip("-.") or "import"
    return name[:60]


# -- building ----------------------------------------------------------------------------------


def _outcome(row: dict) -> str:
    if row.get("committed"):
        return OUTCOMES[row["committed"]]
    return "not_imported" if row.get("checked") else "unchecked"


def _row_entry(svc, batch: dict, row: dict, earlier: set[int], new_tags: list[str]) -> dict[str, Any]:
    from . import downloads, importer

    item = importer.row_item(row)
    info = row.get("commit_info") or {}
    outcome = _outcome(row)
    item_id = None
    if row.get("committed"):  # rows imported before commit_info existed: the same ids _commit used
        merged = outcome in ("merged", "merged_into_other")
        item_id = info.get("item_id") or ((row.get("duplicate") or {}).get("of") if merged else item["id"])
    bc_item = (row.get("bandcamp") or {}).get("item") or {}
    match = row.get("match") or {}
    located = row.get("located") or {}
    mapping = batch.get("tag_mapping") or {}
    entry: dict[str, Any] = {
        "n": row["n"], "line": row.get("line"), "raw": row.get("raw"), "kind": item.get("kind"),
        "artist": item.get("artist"), "title": item.get("title"), "album": album_name(item) or None,
        "tags": list(row.get("tags") or []),
        "tags_from_defaults": importer._default_added(batch, row),
        # {unknown tag: what it became}; null: the mapping ran before logs recorded it per row
        "mapped_tags": (row.get("mapped_tags") or {}) if mapping.get("per_row") or not mapping else None,
        "new_tags": [t for t in row.get("tags") or [] if t in new_tags],
        "outcome": outcome, "item_id": item_id, "order": info.get("order"), "imported_earlier": row["n"] in earlier,
        "match": {"source": row.get("match_source"), "status": match.get("status"),
                  "via": (row.get("bandcamp") or {}).get("via"), "confidence": match.get("confidence")},
        "bandcamp_url": bc_item.get("item_url") or bc_item.get("url") or (row.get("hints") or {}).get("bandcamp_url"),
        "located": {"status": located.get("status"), "path": (located.get("best") or {}).get("path"),
                    "manual": bool(located.get("manual"))},
        "downloads": downloads.downloads_for(svc.store, [item_id, item.get("id"), bc_item.get("id")],
                                             [f"{batch['batch_id']}:{row['n']}"], batch["created_at"]),
        "flags": row.get("flags") or [],
    }
    if "tags_before" in info:
        entry["tags_before"], entry["tags_after"] = info["tags_before"], info["tags_after"]
    return entry


def build(svc, batch: dict, rows: list[dict], result: dict | None, earlier: set[int],
          error: str | None = None) -> dict[str, Any]:
    new_tags = (result or {}).get("new_tags") or []
    entries = [_row_entry(svc, batch, r, earlier, new_tags) for r in rows]
    counts = Counter(e["outcome"] for e in entries)
    return {
        "format": FORMAT,
        "logged_at": now_iso(),
        "status": "partial" if error else "complete",
        "error": error,
        "batch": {
            "id": batch["batch_id"], "name": batch.get("name"), "source_file": batch.get("source_file"),
            "revision": batch.get("revision"), "created_at": batch.get("created_at"),
            "committed_at": batch.get("committed_at"), "default_tags": batch.get("default_tags") or [],
            "default_tags_all": bool(batch.get("default_tags_all")), "lookup": batch.get("lookup") or "server",
            "lookup_source": batch.get("lookup_source"), "tag_mapping": batch.get("tag_mapping"),
            "new_tags": new_tags, "stats": batch.get("stats") or {},
        },
        "counts": {
            "total": len(entries), **{k: counts.get(k, 0) for k in LABELS},
            "imported_earlier": sum(e["imported_earlier"] for e in entries),
            "located": sum(e["located"]["status"] == "located" for e in entries),
            "downloaded": sum(any(d["state"] == "done" for d in e["downloads"]) for e in entries),
        },
        "selected": (result or {}).get("selected"),
        "rows": entries,
    }


def _cell(value: Any) -> str:
    return str(value if value not in (None, "") else "–").replace("|", "\\|").replace("\n", " ")


def markdown(log: dict) -> str:
    b, c = log["batch"], log["counts"]
    when = _local(b.get("committed_at") or log["logged_at"]).strftime("%Y-%m-%d %H:%M")
    lines = [f"# Import: {b['name']} ({when})", ""]
    lines.append(f"Batch `{b['id']}`" + (f" · file `{b['source_file']}`" if b.get("source_file") else "")
                 + f" · lookups: {b['lookup']}" + (f", {b['lookup_source']}" if b.get("lookup_source") else ""))
    if b["default_tags"]:
        lines.append(f"Default tags: {', '.join(b['default_tags'])} "
                     f"({'added to every row' if b['default_tags_all'] else 'for untagged rows'})")
    if log["status"] == "partial":
        lines += ["", f"**The import stopped part way:** {log['error']}. Import again: rows already imported are "
                      "skipped."]
    lines += ["", "| | Rows |", "|---|---|"]
    for key, label in LABELS.items():
        if c[key] or key in ("added_to_tagger", "merged", "added_to_other"):
            lines.append(f"| {label.capitalize()} | {c[key]} |")
    lines.append(f"| Located on disk | {c['located']} |")
    if c["downloaded"]:
        lines.append(f"| Downloaded for this import | {c['downloaded']} |")
    if c["imported_earlier"]:
        lines.append(f"| Imported by an earlier attempt | {c['imported_earlier']} |")
    if b["new_tags"]:
        lines.append(f"| New tags | {', '.join(b['new_tags'])} |")
    lines += ["", "| Line | Artist – Title | Outcome | Tags | Located | Download |", "|---|---|---|---|---|---|"]
    for e in log["rows"]:
        outcome = LABELS[e["outcome"]] + (f" ({e['item_id']})" if e["item_id"] else "")
        if "tags_before" in e and e["tags_before"] != e["tags_after"]:
            outcome += f": {', '.join(e['tags_before']) or 'no tags'} → {', '.join(e['tags_after'])}"
        located = e["located"]["status"]
        if located == "located" and e["located"]["path"]:  # folder/file (the JSON has the full path)
            located = "/".join(Path(e["located"]["path"]).parts[-2:])
        download = "; ".join(f"{d['state']}: {d['message']}" for d in e["downloads"]) or None
        name = " – ".join(x for x in (e["artist"], e["title"]) if x)
        lines.append("| " + " | ".join(_cell(v) for v in (e["line"], name, outcome, ", ".join(e["tags"]), located,
                                                          download)) + " |")
    return "\n".join(lines) + "\n"


def _local(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()


# -- writing -----------------------------------------------------------------------------------


def write(svc, batch: dict, rows: list[dict], result: dict | None, earlier: set[int],
          error: str | None = None) -> dict[str, Any]:
    folder, warning = log_dir(svc)
    log = build(svc, batch, rows, result, earlier, error)
    base = f"{_local(log['logged_at']).strftime('%Y-%m-%d_%H%M%S')}_{_slug(batch.get('name'))}_{batch['batch_id']}"
    stem, n = base, 1
    while (folder / f"{stem}.json").exists():  # a second attempt in the same second
        n += 1
        stem = f"{base}-{n}"
    (folder / f"{stem}.json").write_text(json.dumps(log, indent=2, ensure_ascii=False))
    (folder / f"{stem}.md").write_text(markdown(log))
    return {"name": f"{stem}.json", "md": f"{stem}.md", "dir": str(folder), "warning": warning}


def attach(svc, batch: dict, rows: list[dict], result: dict | None, earlier: set[int],
           error: str | None = None) -> None:
    """Write the log; its file name goes to ``result["log"]`` (when given) and ``batch["logs"]``."""
    out: dict[str, Any] = {}
    try:
        written = write(svc, batch, rows, result, earlier, error)
        batch["logs"] = (batch.get("logs") or []) + [written["name"]]
        out = {"log": written["name"], "log_md": written["md"], "log_dir": written["dir"]}
        if written["warning"]:
            out["log_warning"] = written["warning"]
    except Exception as e:  # noqa: BLE001 - the import itself is done; say why there's no log
        out = {"log": None, "log_error": f"{type(e).__name__}: {e}"}
    if result is not None:
        result.update(out)


# -- reading -----------------------------------------------------------------------------------


def list_logs(svc) -> dict[str, Any]:
    folder, warning = log_dir(svc, create=False)
    out = []
    for path in folder.glob("*.json"):
        md = path.with_suffix(".md")
        entry: dict[str, Any] = {"name": path.name, "md": md.name if md.exists() else None}
        try:
            log = json.loads(path.read_text())
            entry.update(logged_at=log.get("logged_at"), status=log.get("status"), batch_id=log["batch"]["id"],
                         batch_name=log["batch"].get("name"), counts=log.get("counts"))
        except (OSError, ValueError, KeyError, TypeError) as e:
            entry.update(logged_at=None, error=f"unreadable: {type(e).__name__}")
        out.append((entry.get("logged_at") or "", path.stat().st_mtime_ns, entry))
    out.sort(key=lambda e: e[:2], reverse=True)  # newest first (logged_at has whole seconds)
    return {"dir": str(folder), "warning": warning, "logs": [e for _, _, e in out]}


def log_path(svc, name: str) -> Path:
    folder, _ = log_dir(svc, create=False)
    if not _FILE.match(name or "") or not (folder / name).is_file():
        raise LogNotFound(name)
    return folder / name


def read(svc, name: str) -> tuple[str, str]:
    """(content, media type) of a log file."""
    path = log_path(svc, name)
    return path.read_text(), "application/json" if path.suffix == ".json" else "text/markdown; charset=utf-8"


def _open(args: list[str]) -> None:
    subprocess.run(["open", *args], check=False, capture_output=True, timeout=10)


def reveal(svc, name: str | None = None) -> dict[str, Any]:
    """Show a log in Finder (``open -R``), or open the logs folder."""
    if name:
        path = log_path(svc, name)
        _open(["-R", str(path)])
    else:
        path, _ = log_dir(svc)
        _open([str(path)])
    return {"revealed": str(path)}
