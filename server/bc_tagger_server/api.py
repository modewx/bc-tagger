"""FastAPI app: the JSON API (contract v0 in LOCAL_COLLECTION_PLAN.md) plus the built local app."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import PRESETS, SettingsError
from .service import Service

log = logging.getLogger(__name__)

# Browser pages allowed to call the API: extension pages and local pages on any port.
ALLOWED_ORIGIN_RE = r"^(chrome-extension://[a-p]{32}|http://(127\.0\.0\.1|localhost)(:\d+)?)$"
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "testserver"}


class SyncItemsBody(BaseModel):
    items: dict[str, dict] = Field(default_factory=dict)
    deleted: list[str] = Field(default_factory=list)
    full: bool = False


class SyncTagsBody(BaseModel):
    tags: list[str]


class TagEditBody(BaseModel):
    id: str
    tags: list[str]


class AckBody(BaseModel):
    ids: list[int]


class OwnershipBody(BaseModel):
    owned_ids: list[str]
    source: str = "extension"
    full: bool = False


class SelectionBody(BaseModel):
    ids: Optional[list[str]] = None
    latest: Optional[int] = None
    dry_run: bool = False


class PathBody(BaseModel):
    path: str


def create_app(service: Service | None = None) -> FastAPI:
    svc = service or Service()
    app = FastAPI(title="bc-tagger local server", version=svc.health()["version"])
    app.state.service = svc

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=ALLOWED_ORIGIN_RE,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Total-Count"],
    )

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        # Block DNS rebinding and cross-site requests from arbitrary web pages.
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
        if host and host not in ALLOWED_HOSTS:
            return JSONResponse({"detail": "forbidden host"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and not re.match(ALLOWED_ORIGIN_RE, origin):
            return JSONResponse({"detail": "forbidden origin"}, status_code=403)
        return await call_next(request)

    # -- read endpoints ----------------------------------------------------------------

    @app.get("/api/health")
    def health() -> dict:
        return svc.health()

    @app.get("/api/items")
    def items(
        response: Response,
        q: str = "",
        tag: Optional[str] = None,
        limit: Optional[int] = Query(None, ge=0),
        offset: int = Query(0, ge=0),
        ids: Optional[str] = Query(None, description="comma-separated item ids"),
    ) -> list[dict]:
        id_list = [i for i in ids.split(",") if i] if ids else None
        total, page = svc.list_items(q=q, tag=tag, limit=limit, offset=offset, ids=id_list)
        response.headers["X-Total-Count"] = str(total)
        return page

    @app.get("/api/items/{item_id}")
    def item(item_id: str) -> dict:
        view = svc.get_item_view(item_id)
        if view is None:
            raise HTTPException(404, f"unknown item {item_id}")
        return view

    @app.get("/api/tags")
    def tags() -> list[str]:
        return svc.store.get_tags()

    # -- extension sync ----------------------------------------------------------------

    @app.post("/api/sync/items")
    def sync_items(body: SyncItemsBody) -> dict:
        return svc.sync_items(body.items, body.deleted, body.full)

    @app.post("/api/sync/tags")
    def sync_tags(body: SyncTagsBody) -> dict:
        return svc.sync_tags(body.tags)

    @app.post("/api/tag-edits")
    def tag_edit(body: TagEditBody) -> dict:
        return svc.queue_tag_edit(body.id, body.tags)

    @app.get("/api/tag-edits/pending")
    def tag_edits_pending() -> list[dict]:
        return svc.pending_tag_edits()

    @app.post("/api/tag-edits/ack")
    def tag_edits_ack(body: AckBody) -> dict:
        return svc.ack_tag_edits(body.ids)

    # -- ownership ---------------------------------------------------------------------

    @app.post("/api/ownership")
    def ownership(body: OwnershipBody) -> dict:
        return svc.set_ownership(body.owned_ids, body.source, body.full)

    @app.post("/api/ownership/refresh")
    def ownership_refresh() -> dict:
        return {"job_id": svc.start_ownership_refresh().id}

    # -- index / locate / matches ------------------------------------------------------

    @app.post("/api/index/scan")
    def scan() -> dict:
        return {"job_id": svc.start_scan().id}

    @app.post("/api/locate")
    def locate(body: SelectionBody = Body(default_factory=SelectionBody)) -> dict:
        return {"job_id": svc.start_locate(ids=body.ids, latest=body.latest).id}

    @app.post("/api/matches/{item_id}/confirm")
    def confirm(item_id: str, body: PathBody) -> dict:
        return svc.set_match_override(item_id, body.path, "confirm")

    @app.post("/api/matches/{item_id}/reject")
    def reject(item_id: str, body: PathBody) -> dict:
        return svc.set_match_override(item_id, body.path, "reject")

    # -- rekordbox ---------------------------------------------------------------------

    @app.post("/api/rekordbox/export")
    def rb_export(body: SelectionBody = Body(default_factory=SelectionBody)) -> dict:
        return {"job_id": svc.start_export(ids=body.ids, latest=body.latest, dry_run=body.dry_run).id}

    @app.post("/api/rekordbox/xml")
    def rb_xml(body: SelectionBody = Body(default_factory=SelectionBody)) -> dict:
        return svc.write_xml(ids=body.ids, latest=body.latest)

    # -- jobs & events -----------------------------------------------------------------

    @app.get("/api/jobs")
    def jobs() -> list[dict]:
        return [j.to_dict() for j in svc.jobs.list()]

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str) -> dict:
        j = svc.jobs.get(job_id)
        if j is None:
            raise HTTPException(404, f"unknown job {job_id}")
        return j.to_dict()

    @app.get("/api/events")
    async def events(request: Request) -> StreamingResponse:
        queue = svc.jobs.bus.subscribe()

        async def stream():
            try:
                yield "retry: 3000\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event, data = await asyncio.wait_for(queue.get(), timeout=15)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    yield f"event: {event}\ndata: {json.dumps(data)}\n\n"
            finally:
                svc.jobs.bus.unsubscribe(queue)

        return StreamingResponse(
            stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
        )

    # -- settings ----------------------------------------------------------------------

    @app.get("/api/settings")
    def get_settings() -> dict:
        return {**svc.settings.all(), "presets": PRESETS}

    @app.put("/api/settings")
    def put_settings(changes: dict[str, Any] = Body(...)) -> dict:
        changes = {k: v for k, v in changes.items() if k != "presets"}
        try:
            updated = svc.settings.update(changes)
        except (SettingsError, ValueError, TypeError) as e:
            raise HTTPException(400, str(e)) from e
        return {**updated, "presets": PRESETS}

    # -- files & dev -------------------------------------------------------------------

    @app.get("/api/files/stream")
    def stream_file(request: Request, path: str) -> Response:
        return svc.stream_file(request, path)

    @app.get("/api/dev/build-id")
    def build_id() -> dict:
        return {"build_id": svc.build_id()}

    # -- the built local app -----------------------------------------------------------

    dist = svc.settings.app_dist_dir()
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="app")
    else:

        @app.get("/", response_class=HTMLResponse)
        def placeholder() -> str:
            return (
                "<!doctype html><meta charset=utf-8><title>bc-tagger server</title>"
                "<p>bc-tagger server is running. The local app is not built yet "
                f"(expected at <code>{dist}</code>). API: <a href='/docs'>/docs</a></p>"
            )

    return app
