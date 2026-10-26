"""rekordbox XML fallback: the same folder / one-playlist-per-tag layout as the DB export.

Import it in rekordbox via Preferences > Advanced > rekordbox xml, then drag the
``bc-tagger`` folder from the "rekordbox xml" tree into Playlists. Works while rekordbox
is open, and never touches any master.db.

(pyrekordbox's own writer encodes macOS paths as ``file://localhost//Users/...``, so this
module writes the XML itself.)
"""

from __future__ import annotations

import datetime as dt
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from . import __version__
from .playlists import parts_of
from .rbexport import ExportSelection, merged_meta

KIND = {
    "aiff": "AIFF File",
    "flac": "FLAC File",
    "wav": "WAV File",
    "alac": "M4A File",
    "m4a": "M4A File",
    "mp3": "MP3 File",
    "mp3-320": "MP3 File",
}


def encode_location(path: str) -> str:
    return "file://localhost" + urllib.parse.quote(path, safe="/")


def build_xml(selection: ExportSelection, folder_name: str, file_meta: dict[str, dict]) -> ET.ElementTree:
    root = ET.Element("DJ_PLAYLISTS", Version="1.0.0")
    ET.SubElement(root, "PRODUCT", Name="bc-tagger", Version=__version__, Company="bc-tagger")
    paths = [p for p in selection.tracks if Path(p).is_file()]
    collection = ET.SubElement(root, "COLLECTION", Entries=str(len(paths)))
    today = dt.date.today().isoformat()
    ids: dict[str, int] = {}
    for n, path in enumerate(paths, 1):
        meta = merged_meta(file_meta.get(path, {}), selection.tracks[path].meta)
        ids[path] = n
        attrib: dict[str, Any] = {
            "TrackID": n,
            "Name": meta.get("title") or Path(path).stem,
            "Artist": meta.get("artist") or "",
            "Album": meta.get("album") or "",
            "Genre": meta.get("genre") or "",
            "Kind": KIND.get(meta.get("format") or "", "Audio File"),
            "Size": meta.get("size") or Path(path).stat().st_size,
            "TotalTime": int(round(meta.get("duration") or 0)),
            "DiscNumber": meta.get("discnumber") or 0,
            "TrackNumber": meta.get("tracknumber") or 0,
            "Year": meta.get("year") or 0,
            "DateAdded": today,
            "BitRate": int((meta.get("bitrate") or 0) // 1000),
            "SampleRate": meta.get("sample_rate") or 0,
            "Comments": meta.get("comment") or "",
            "Label": meta.get("label") or "",
            "Location": encode_location(path),
        }
        ET.SubElement(collection, "TRACK", {k: str(v) for k, v in attrib.items()})

    playlists = ET.SubElement(root, "PLAYLISTS")
    root_node = ET.SubElement(playlists, "NODE", Type="0", Name="ROOT", Count="0")
    folders: dict[tuple[str, ...], ET.Element] = {(): root_node}

    def folder_node(parts: tuple[str, ...]) -> ET.Element:
        if parts not in folders:
            parent = folder_node(parts[:-1])
            folders[parts] = ET.SubElement(parent, "NODE", Type="0", Name=parts[-1], Count="0")
        return folders[parts]

    # Same playlists as the DB export (mapped paths); rekordbox imports them under "rekordbox xml".
    for key in selection.playlist_order:
        parts = parts_of(key)
        members = [p for p, plan in selection.tracks.items() if key in plan.playlists and p in ids]
        node = ET.SubElement(folder_node(parts[:-1]), "NODE", Name=parts[-1], Type="1", KeyType="0",
                             Entries=str(len(members)))
        for p in members:
            ET.SubElement(node, "TRACK", Key=str(ids[p]))
    for el in folders.values():
        el.set("Count", str(len(el.findall("NODE"))))
    ET.indent(root, space="  ")
    return ET.ElementTree(root)


def write_xml(selection: ExportSelection, folder_name: str, file_meta: dict[str, dict], out_dir: Path) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    path = out_dir / f"bc-tagger_{stamp}.xml"
    tree = build_xml(selection, folder_name, file_meta)
    tree.write(path, encoding="UTF-8", xml_declaration=True)
    latest = out_dir / "bc-tagger_latest.xml"
    tree.write(latest, encoding="UTF-8", xml_declaration=True)
    return {
        "path": str(path),
        "latest": str(latest),
        "tracks": int(tree.getroot().find("COLLECTION").get("Entries")),
        "playlists": {
            n.get("Name"): int(n.get("Entries")) for n in tree.getroot().iter("NODE") if n.get("Type") == "1"
        },
        "skipped_items": selection.skipped,
    }
