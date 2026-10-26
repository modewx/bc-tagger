"""Command line interface: ``bct <command>`` (see server/README.md)."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

from .service import Service


def _out(obj: Any, args: argparse.Namespace, text: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps(obj, indent=2, default=str))
    else:
        print(text)


def _selection(args: argparse.Namespace) -> dict[str, Any]:
    ids = [i for i in (args.ids or "").split(",") if i] or None
    return {"ids": ids, "latest": args.latest}


def _short(path: str | None, width: int = 90) -> str:
    if not path:
        return ""
    return path if len(path) <= width else "…" + path[-(width - 1):]


def cmd_serve(svc: Service, args: argparse.Namespace) -> int:
    import uvicorn

    from .api import create_app

    port = args.port or svc.settings.get("server_port")
    uvicorn.run(create_app(svc), host="127.0.0.1", port=port, log_level="info")
    return 0


def cmd_seed(svc: Service, args: argparse.Namespace) -> int:
    if args.export_json:
        from .items import seed_from_export

        result = seed_from_export(svc.store, Path(args.export_json).expanduser(), force=True)
    else:
        result = svc.seed_items(force=args.force)
    _out(result, args, json.dumps(result))
    return 0


def cmd_scan(svc: Service, args: argparse.Namespace) -> int:
    stats = svc.scan()
    lines = [f"{r['kind']:9} {'ok' if r['exists'] else 'MISSING':7} {r['files']:6} files  {r['path']}" for r in stats["roots"]]
    lines.append(
        f"files={stats['files']} read={stats['read']} unchanged={stats['unchanged']} "
        f"removed={stats['removed']} errors={stats['errors']}"
    )
    _out(stats, args, "\n".join(lines))
    return 0


def cmd_locate(svc: Service, args: argparse.Namespace) -> int:
    sel = _selection(args)
    if sel["ids"] is None and sel["latest"] is None and not args.all:
        print("choose --latest N, --ids ID,ID or --all", file=sys.stderr)
        return 2
    result = svc.locate(**sel)
    lines = []
    for s in result["items"]:
        kind = "album" if s["is_album"] else "track"
        head = f"{s['status']:10} {kind:5} {s['id']:12} {s['artist'] or '?'} – {s['title']}"
        if s["status"] == "located":
            extra = f" ({s['tracks']} tracks)" if s["is_album"] else ""
            head += f"\n{'':29}→ [{s['format']} {s['confidence']:.2f}]{extra} {_short(s['path'])}"
        elif s["status"] == "candidates":
            head += f"  ({s['candidates']} candidates to confirm)"
        lines.append(head)
    lines.append("counts: " + ", ".join(f"{k}={v}" for k, v in sorted(result["counts"].items())))
    _out(result, args, "\n".join(lines))
    return 0


def _diff_text(diff: dict[str, Any]) -> str:
    g = diff.get("guard") or {}
    lines = [
        f"db: {diff['db_path']}{'  (DRY RUN)' if diff['dry_run'] else ''}",
        f"guard: {g.get('reason')}",
    ]
    if diff.get("backup"):
        lines.append(f"backup: {diff['backup']}")
    lines.append(f"items: {diff['items']} selected, tracks: {diff['tracks']}")
    for it in diff.get("selected_items", []):
        lines.append(f"  - {it['id']:12} {it['title']}  {it.get('tags') or ''}")
    f = diff["folder"]
    lines.append(f"folder '{f['name']}': {'created' if f['created'] else 'exists'}")
    lines.append(f"content: {len(diff['content_added'])} added, {diff['content_existing']} already present"
                 + (f", {len(diff['content_updated'])} filled in" if diff.get("content_updated") else ""))
    for u in diff.get("content_updated", []):
        lines.append(f"  ~ filled {', '.join(u['fields'])}: {_short(u['path'])}")
    if diff["playlists_created"]:
        lines.append(f"playlists created: {', '.join(diff['playlists_created'])}")
    lines.append(
        f"entries: {len(diff['entries_added'])} added, {len(diff['entries_removed'])} removed, "
        f"{diff['entries_kept_user']} user entries left alone"
    )
    for e in diff["entries_removed"]:
        lines.append(f"  - removed [{e['tag']}] {_short(e['path'])}")
    if diff["missing_files"]:
        lines.append(f"missing files: {len(diff['missing_files'])}")
    for f in diff.get("failed_files", []):
        lines.append(f"  ! not added ({f['error']}): {_short(f['path'])}")
    if diff["skipped_items"]:
        lines.append("skipped: " + ", ".join(f"{s['id']} ({s['status']})" for s in diff["skipped_items"]))
    lines.append("changed: " + ("yes" if diff.get("changed") else "no (nothing to do)"))
    return "\n".join(lines)


def cmd_export(svc: Service, args: argparse.Namespace) -> int:
    sel = _selection(args)
    if sel["ids"] is None and sel["latest"] is None and not args.all:
        print("choose --latest N, --ids ID,ID or --all", file=sys.stderr)
        return 2
    diff = svc.export(**sel, dry_run=args.dry_run)
    _out(diff, args, _diff_text(diff))
    return 0


def cmd_xml(svc: Service, args: argparse.Namespace) -> int:
    sel = _selection(args)
    if sel["ids"] is None and sel["latest"] is None and not args.all:
        print("choose --latest N, --ids ID,ID or --all", file=sys.stderr)
        return 2
    result = svc.write_xml(**sel)
    text = [f"wrote {result['path']} ({result['tracks']} tracks)", f"also {result['latest']}"]
    text += [f"  {name}: {n}" for name, n in result["playlists"].items()]
    _out(result, args, "\n".join(text))
    return 0


def cmd_rb_status(svc: Service, args: argparse.Namespace) -> int:
    from .rbexport import read_back
    from .rbguard import check_write

    folder = svc.settings.get("playlist_folder")
    state = read_back(svc.db_path(), folder)
    state["guard"] = check_write(svc.db_path()).to_dict()
    lines = [
        f"db: {state['db_path']}",
        f"write guard: {state['guard']['reason']}",
        f"content rows: {state['content_count']}  duplicate paths: {len(state.get('duplicate_content_paths', []))}",
    ]
    if state["folder"] is None:
        lines.append(f"folder '{folder}': not found")
    else:
        lines.append(f"folder '{folder}' (id {state['folder']['id']}):")
        for name, paths in state["playlists"].items():
            lines.append(f"  {name} ({len(paths)})")
            if args.tracks:
                lines += [f"      {_short(p)}" for p in paths]
    _out(state, args, "\n".join(lines))
    return 0


def cmd_rb_restore(svc: Service, args: argparse.Namespace) -> int:
    from .rbguard import BACKUP_DIRNAME, resolve, restore

    db_path = resolve(svc.db_path())
    backups = sorted((db_path.parent / BACKUP_DIRNAME).glob(f"{db_path.stem}_*.db"))
    if not args.backup:
        for b in backups:
            print(b.name)
        return 0
    src = Path(args.backup)
    if not src.is_absolute():
        src = db_path.parent / BACKUP_DIRNAME / src
    result = restore(db_path, src)
    # The DB no longer holds what this data dir recorded as exported.
    with svc.store.tx() as c:
        for table in ("rb_content", "rb_claims", "rb_entries"):
            c.execute(f"DELETE FROM {table} WHERE db_path = ?", (str(db_path),))
    _out(result, args, f"restored {result['db_path']} from {Path(result['restored_from']).name}\n"
         f"previous state saved as {result['previous_saved_as']}\nexport tracking for this DB reset")
    return 0


def cmd_settings(svc: Service, args: argparse.Namespace) -> int:
    if args.set:
        changes = {}
        for kv in args.set:
            key, _, value = kv.partition("=")
            try:
                changes[key] = json.loads(value)
            except json.JSONDecodeError:
                changes[key] = value
        svc.settings.update(changes)
    data = svc.settings.all()
    _out(data, args, json.dumps(data, indent=2))
    return 0


def add_selection(p: argparse.ArgumentParser) -> None:
    p.add_argument("--latest", type=int, default=None, help="the N most recent items")
    p.add_argument("--ids", default=None, help="comma-separated item ids (t123,a456)")
    p.add_argument("--all", action="store_true", help="every item")
    p.add_argument("--json", action="store_true", help="print JSON")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="bct", description="bc-tagger local server and tools")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--data-dir", default=None, help="state dir (default ~/Library/Application Support/bc-tagger)")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve", help="run the HTTP server on 127.0.0.1")
    s.add_argument("--port", type=int, default=None)
    s.set_defaults(func=cmd_serve)

    s = sub.add_parser("seed", help="(re)load the items mirror from the export JSON")
    s.add_argument("--force", action="store_true", help="replace the mirror even if not empty")
    s.add_argument("--export-json", default=None, help="load this export JSON instead of the configured one")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_seed)

    s = sub.add_parser("scan", help="index the configured roots (incremental)")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_scan)

    s = sub.add_parser("locate", help="match items to local files")
    add_selection(s)
    s.set_defaults(func=cmd_locate)

    s = sub.add_parser("export", help="export located tracks to the rekordbox test DB")
    add_selection(s)
    s.add_argument("--dry-run", action="store_true", help="show the diff without writing")
    s.set_defaults(func=cmd_export)

    s = sub.add_parser("xml", help="write the rekordbox XML fallback")
    add_selection(s)
    s.set_defaults(func=cmd_xml)

    s = sub.add_parser("rb-status", help="re-read the rekordbox DB: folder, playlists, tracks")
    s.add_argument("--tracks", action="store_true", help="list track paths per playlist")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_rb_status)

    s = sub.add_parser("rb-restore", help="list backups of the rekordbox test DB, or restore one")
    s.add_argument("backup", nargs="?", help="backup file name (from the list) or path")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_rb_restore)

    s = sub.add_parser("settings", help="show or change settings")
    s.add_argument("--set", action="append", metavar="KEY=VALUE", help="JSON values allowed")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=cmd_settings)

    from .ownership import add_cli as add_ownership_cli

    add_ownership_cli(sub)
    from .downloader import add_cli as add_downloader_cli

    add_downloader_cli(sub)
    from .report import add_cli as add_report_cli

    add_report_cli(sub)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.data_dir:
        os.environ["BC_TAGGER_DATA_DIR"] = str(Path(args.data_dir).expanduser())
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING if getattr(args, "json", False) else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    svc = Service()
    try:
        return args.func(svc, args)
    finally:
        svc.jobs.shutdown()


if __name__ == "__main__":
    sys.exit(main())
