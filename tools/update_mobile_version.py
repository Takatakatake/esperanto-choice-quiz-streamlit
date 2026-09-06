#!/usr/bin/env python3
"""Synchronize the mobile app, stylesheet URL, and service worker versions."""

from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_RE = re.compile(r'const APP_VERSION = "([^"]+)";')
CACHE_VERSION_RE = re.compile(r'const CACHE_VERSION = "esperanto-mobile-pwa-[^"]+";')
INDEX_STYLESHEET_RE = re.compile(r'href="\./styles\.css(?:\?[^"]*)?"')
SHELL_STYLESHEET_RE = re.compile(r'"\./mobile_app/styles\.css(?:\?[^"]*)?"')
SAFE_VERSION_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}-[A-Za-z0-9._-]+$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "version",
        nargs="?",
        help="Version string to write, for example 2026-05-16-mobile-quality-1.",
    )
    parser.add_argument(
        "--label",
        default="mobile-update",
        help="Label used when version is omitted. Default: mobile-update.",
    )
    return parser.parse_args()


def default_version(label: str) -> str:
    safe_label = re.sub(r"[^A-Za-z0-9._-]+", "-", label.strip()).strip("-") or "mobile-update"
    return f"{dt.date.today().isoformat()}-{safe_label}"


def update_mobile_version(version: str, *, root: Path = ROOT) -> list[Path]:
    """Validate all version locations before changing any file."""
    if not SAFE_VERSION_RE.fullmatch(version):
        raise ValueError("Version must look like YYYY-MM-DD-label and use only letters, digits, dot, underscore, or hyphen.")

    replacements = {
        root / "mobile_app" / "app.js": [
            (VERSION_RE, f'const APP_VERSION = "{version}";'),
        ],
        root / "mobile_app" / "index.html": [
            (INDEX_STYLESHEET_RE, f'href="./styles.css?v={version}"'),
        ],
        root / "mobile-sw.js": [
            (CACHE_VERSION_RE, f'const CACHE_VERSION = "esperanto-mobile-pwa-{version}";'),
            (SHELL_STYLESHEET_RE, f'"./mobile_app/styles.css?v={version}"'),
        ],
    }
    pending: list[tuple[Path, str]] = []
    for path, patterns in replacements.items():
        original = path.read_text(encoding="utf-8")
        updated = original
        for pattern, replacement in patterns:
            if len(pattern.findall(updated)) != 1:
                raise ValueError(f"Expected exactly one {pattern.pattern} in {path.relative_to(root)}.")
            updated = pattern.sub(lambda _match: replacement, updated, count=1)
        if updated != original:
            pending.append((path, updated))

    # A missing or ambiguous location must not leave a partially updated release.
    for path, updated in pending:
        path.write_text(updated, encoding="utf-8")
    return [path for path, _updated in pending]


def main() -> int:
    args = parse_args()
    version = args.version.strip() if args.version else default_version(args.label)
    if not SAFE_VERSION_RE.fullmatch(version):
        print(
            "Version must look like YYYY-MM-DD-label and use only letters, digits, dot, underscore, or hyphen.",
            file=sys.stderr,
        )
        return 2

    try:
        changed = update_mobile_version(version)
    except (OSError, ValueError) as error:
        print(f"Could not update mobile versions: {error}", file=sys.stderr)
        return 1
    if changed:
        print(f"Updated mobile app and asset versions to {version} ({len(changed)} files).")
    else:
        print(f"Mobile app and asset versions are already {version}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
