"""Match-quality report (``bct match-report``): counts plus a sample to spot-check by hand."""

from __future__ import annotations

import argparse
import random
from collections import Counter
from pathlib import Path

from .items import is_album, is_valid_id
from .store import now_iso
from .views import item_view


def _short(path: str | None, roots: list[str]) -> str:
    for r in roots:
        if path and path.startswith(r.rstrip("/") + "/"):
            return "…/" + Path(r).name + path[len(r.rstrip("/")):]
    return path or ""


def build(svc, sample: int = 12, seed: int = 7) -> str:
    db_path = svc.db_path()
    views = [item_view(svc.store, it, db_path) for it in svc.store.all_items() if is_valid_id(it["id"])]
    roots = svc.settings.roots()
    root_paths = [r["path"] for r in roots]
    status = Counter(v["local"]["status"] for v in views)
    by_owned = Counter((v["owned"]["status"], v["local"]["status"]) for v in views)
    hints = Counter(h for v in views for h in v["local"].get("hints", []))
    located = [v for v in views if v["local"]["status"] == "located"]
    fmt = Counter(v["local"]["best"].get("format") for v in located)
    root_kind = Counter(v["local"]["best"].get("root_kind") for v in located)
    files_per_root = {r["root"]: r["n"] for r in svc.store.query("SELECT root, COUNT(*) AS n FROM files GROUP BY root")}
    last_scan = svc.store.get_meta("last_scan") or {}

    out = [
        "# Match report",
        "",
        f"Generated {now_iso()} by `bct match-report` from the server's index and locate results.",
        "",
        "## Index",
        "",
        "| root | kind | mounted | files indexed |",
        "|---|---|---|---|",
    ]
    for r in roots:
        p = str(Path(r["path"]).expanduser())
        out.append(f"| `{p}` | {r['kind']} | {'yes' if Path(p).is_dir() else '**no**'} | {files_per_root.get(p, 0)} |")
    if last_scan.get("incomplete_roots"):
        out.append(f"\nLast scan was incomplete for: {', '.join(last_scan['incomplete_roots'])}")
    out += [
        "",
        f"## Items ({len(views)}: {sum(is_album(v) for v in views)} albums, {sum(not is_album(v) for v in views)} tracks)",
        "",
        "| status | count |",
        "|---|---|",
        *[f"| {k} | {status.get(k, 0)} |" for k in ("located", "candidates", "missing", "unknown")],
        "",
        "| ownership | located | candidates | missing |",
        "|---|---|---|---|",
        *[
            f"| {o} | {by_owned.get((o, 'located'), 0)} | {by_owned.get((o, 'candidates'), 0)} | {by_owned.get((o, 'missing'), 0)} |"
            for o in ("owned", "not_owned", "unknown")
        ],
        "",
        "Located by root kind: " + ", ".join(f"{k}: {n}" for k, n in root_kind.most_common()),
        "",
        "Located by format: " + ", ".join(f"{k}: {n}" for k, n in fmt.most_common()),
        "",
        "Hints: " + (", ".join(f"`{k}`: {n}" for k, n in hints.most_common()) or "none"),
        "",
        "## Sample to spot-check",
        "",
        "Lowest-confidence located items, a random sample of the rest, and all candidates.",
        "",
        "| item | → local file | conf | title / artist / album scores |",
        "|---|---|---|---|",
    ]

    def line(v, e):
        sc = e.get("scores") or {}
        scores = " / ".join("–" if sc.get(k) is None else f"{sc[k]:.2f}" for k in ("title", "artist", "album"))
        return (
            f"| {v.get('artist') or '?'} – {v.get('title')} | `{_short(e.get('path'), root_paths)}` "
            f"| {e.get('confidence', 0):.2f} {e.get('method', '')} | {scores} |"
        )

    lowest = sorted(located, key=lambda v: v["local"]["best"]["confidence"])[:5]
    rest = [v for v in located if v not in lowest]
    random.Random(seed).shuffle(rest)
    for v in lowest + rest[:sample]:
        out.append(line(v, v["local"]["best"]))
    for v in views:
        if v["local"]["status"] == "candidates":
            for c in v["local"]["candidates"][:2]:
                out.append(line(v, c) + " _(candidate)_")
    return "\n".join(out) + "\n"


def _cmd(svc, args: argparse.Namespace) -> int:
    text = build(svc, sample=args.sample)
    if args.out:
        from .fsguard import require_mounted

        require_mounted(args.out)
        Path(args.out).write_text(text)
        print(f"wrote {args.out}")
    else:
        print(text)
    return 0


def add_cli(sub) -> None:
    p = sub.add_parser("match-report", help="counts + spot-check sample of the current locate results")
    p.add_argument("--out", default=None, help="write markdown here instead of stdout")
    p.add_argument("--sample", type=int, default=12)
    p.set_defaults(func=_cmd)
