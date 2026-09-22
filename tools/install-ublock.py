#!/usr/bin/env python3
"""Install a pinned, verified uBlock Origin Firefox add-on into a directory."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path


EXPECTED_ID = "uBlock0@raymondhill.net"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_extract(archive: zipfile.ZipFile, destination: Path) -> None:
    root = destination.resolve()
    for member in archive.infolist():
        target = (destination / member.filename).resolve()
        if target != root and root not in target.parents:
            raise RuntimeError(f"unsafe archive path: {member.filename}")
    archive.extractall(destination)


def install(args: argparse.Namespace) -> None:
    archive_path = Path(args.archive).resolve()
    output_path = Path(args.output).resolve()
    actual_sha256 = sha256(archive_path)
    if actual_sha256 != args.expected_sha256.lower():
        raise RuntimeError(
            f"uBlock archive sha256 mismatch: expected {args.expected_sha256}, found {actual_sha256}"
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_parent = Path(tempfile.mkdtemp(prefix="onegl-ublock-", dir=str(output_path.parent)))
    try:
        with zipfile.ZipFile(archive_path) as archive:
            bad_member = archive.testzip()
            if bad_member:
                raise RuntimeError(f"uBlock archive is corrupt at {bad_member}")
            manifest_raw = archive.read("manifest.json")
            manifest = json.loads(manifest_raw)
            addon_id = (
                manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id")
                or manifest.get("applications", {}).get("gecko", {}).get("id")
            )
            version = str(manifest.get("version", "")).strip()
            if addon_id != EXPECTED_ID:
                raise RuntimeError(f"unexpected uBlock extension id: {addon_id or '<missing>'}")
            if version != args.expected_version:
                raise RuntimeError(
                    f"uBlock version mismatch: expected {args.expected_version}, found {version or '<missing>'}"
                )
            safe_extract(archive, temp_parent)

        if not (temp_parent / "manifest.json").is_file():
            raise RuntimeError("uBlock extraction did not produce manifest.json")
        if output_path.exists():
            shutil.rmtree(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(temp_parent), str(output_path))
        temp_parent = None
        print(f"Installed uBlock Origin {args.expected_version} at {output_path}")
    finally:
        if temp_parent is not None:
            shutil.rmtree(temp_parent, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--expected-sha256", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    install(parse_args())
