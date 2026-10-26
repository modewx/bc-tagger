"""Command line interface: ``bct <command>`` (see server/README.md)."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any

from .service import Service


def _print(obj: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(obj, indent=2, default=str))


def cmd_serve(svc: Service, args: argparse.Namespace) -> int:
    import uvicorn

    from .api import create_app

    port = args.port or svc.settings.get("server_port")
    uvicorn.run(create_app(svc), host="127.0.0.1", port=port, log_level="info")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="bct", description="bc-tagger local server and tools")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("serve", help="run the HTTP server on 127.0.0.1")
    s.add_argument("--port", type=int, default=None)
    s.set_defaults(func=cmd_serve)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    svc = Service()
    return args.func(svc, args)


if __name__ == "__main__":
    sys.exit(main())
