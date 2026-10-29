"""playlist_mappings: a tag → playlist mapping per rekordbox library, migrated from the flat keys."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from bc_tagger_server.api import create_app
from bc_tagger_server.config import Settings, SettingsError


def test_migrated_from_the_flat_keys(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"playlist_folder": "My Tags", "tag_playlist_mode": "custom",
                                "tag_playlist_map": {"deep": ["Deep", " Deep "], "dub": "Dubs"}}))
    s = Settings(path=path)
    entry = {"folder": "My Tags", "mode": "custom", "map": {"deep": ["Deep"], "dub": ["Dubs"]}, "saved": {}}
    assert s.get("playlist_mappings") == {"test": entry, "main": entry}
    s.update({"quick_scan_margin_days": 3})
    assert json.loads(path.read_text())["playlist_mappings"] == {"test": entry, "main": entry}
    assert Settings(path=path).get("playlist_mappings") == {"test": entry, "main": entry}  # stable once written


def test_the_flat_keys_are_the_library_in_use(tmp_path):
    s = Settings(path=tmp_path / "settings.json")
    s.update({"tag_playlist_mode": "custom", "tag_playlist_map": {"deep": ["Deep"]}})  # in use: test
    assert s.get("playlist_mappings")["test"]["map"] == {"deep": ["Deep"]}
    assert s.get("playlist_mappings")["main"]["mode"] == "auto"
    s.update({"rekordbox_target": "main"})
    assert (s.get("tag_playlist_mode"), s.get("tag_playlist_map")) == ("auto", {})  # main's
    s.update({"rekordbox_target": "test", "playlist_folder": "Test Tags"})  # with the switch: the new one's
    assert s.get("playlist_mappings")["test"]["folder"] == "Test Tags"
    assert s.get("playlist_mappings")["main"]["folder"] == "bc-tagger"
    # a PUT of playlist_mappings wins over flat keys sent with it
    s.update({"playlist_folder": "ignored", "playlist_mappings": {"test": {"folder": "T", "mode": "auto"}}})
    assert s.get("playlist_folder") == "T"


def test_api_round_trip_per_library(make_service, tmp_path):
    svc = make_service(tmp_path / "music")
    (tmp_path / "music").mkdir(exist_ok=True)
    with TestClient(create_app(svc)) as c:
        before = c.get("/api/settings").json()["playlist_mappings"]["test"]
        r = c.put("/api/settings", json={"playlist_mappings": {"main": {
            "folder": " Main Tags ", "mode": "custom", "map": {"x": "A", "y": ["B", "", "B"]},
            "saved": {" Old Folder ": {"mode": "custom", "map": {"x": ["Old A"]}}, "Auto One": {"mode": "auto"}}}}})
        assert r.status_code == 200, r.text
        main = {"folder": "Main Tags", "mode": "custom", "map": {"x": ["A"], "y": ["B"]},
                "saved": {"Old Folder": {"mode": "custom", "map": {"x": ["Old A"]}},
                          "Auto One": {"mode": "auto", "map": {}}}}
        got = c.get("/api/settings").json()
        assert got["playlist_mappings"] == {"test": before, "main": main}  # test untouched: per library
        assert set(got["derived"]["mapping_warnings"]) == {"test", "main"}
        assert got["playlist_folder"] == before["folder"]  # in use: test


@pytest.mark.parametrize("value, says", [
    ([], "must be an object"),
    ({"other": {"folder": "x", "mode": "auto"}}, "unknown libraries"),
    ({"main": "x"}, "must be an object"),
    ({"main": {"folder": "x", "mode": "auto", "extra": 1}}, "unknown keys"),
    ({"main": {"folder": "  ", "mode": "auto"}}, ".folder must be a folder name"),
    ({"main": {"folder": 3, "mode": "auto"}}, ".folder must be a folder name"),
    ({"main": {"folder": "x", "mode": "manual"}}, ".mode must be 'auto' or 'custom'"),
    ({"main": {"folder": "x", "mode": "custom", "map": ["a"]}}, ".map must be an object"),
    ({"main": {"folder": "x", "mode": "custom", "map": {"t": ["a//b"]}}}, "empty path segment"),
    ({"main": {"folder": "x", "mode": "custom", "map": {"t": [1]}}}, "must be a list of playlist names"),
    ({"main": {"folder": "x", "mode": "auto", "saved": []}}, ".saved must be an object"),
    ({"main": {"folder": "x", "mode": "auto", "saved": {" ": {"mode": "auto"}}}}, "a folder name"),
    ({"main": {"folder": "x", "mode": "auto", "saved": {"f": {"mode": "auto", "x": 1}}}}, "must be an object {mode, map}"),
    ({"main": {"folder": "x", "mode": "auto", "saved": {"f": {"mode": "?"}}}}, ".mode must be 'auto' or 'custom'"),
])
def test_invalid_shapes_are_refused(tmp_path, make_service, value, says):
    s = Settings(path=tmp_path / "settings.json")
    before = s.get("playlist_mappings")
    with pytest.raises(SettingsError, match="playlist_mappings") as e:
        s.update({"playlist_mappings": value})
    assert says in str(e.value)
    assert s.get("playlist_mappings") == before
