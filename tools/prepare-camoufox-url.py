"""Make Camoufox's build-time browser download work behind GitHub asset proxies.

Camoufox discovers release assets through the GitHub API but stores the direct
github.com download URL.  On some deployment networks that URL stalls while
the API asset endpoint can still redirect to the release-asset CDN.  Resolve
that redirect during the image build, use it once, then restore the original
public URL so no short-lived signed URL is left in the image metadata.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import requests


def cache_path() -> Path:
    return Path(
        os.environ.get(
            "CAMOUFOX_CACHE_FILE",
            Path.home() / ".cache" / "camoufox" / "repo_cache.json",
        )
    )


def load_cache(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_cache(path: Path, cache: dict) -> None:
    path.write_text(
        json.dumps(cache, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def selected_version(cache: dict) -> tuple[dict, dict]:
    official = next(
        repo
        for repo in cache.get("repos", [])
        if str(repo.get("name", "")).lower() == "official"
    )
    versions = official.get("versions", [])
    pinned = os.environ.get("CAMOUFOX_PINNED_VERSION", "").strip().lower()
    stable = [version for version in versions if not version.get("is_prerelease")]
    candidates = versions if pinned else stable
    if pinned:
        candidates = [
            version
            for version in candidates
            if f"{version.get('version')}-{version.get('build')}".lower() == pinned
        ]
    if not candidates:
        raise RuntimeError("No matching stable Camoufox version in repo_cache.json")
    return official, candidates[0]


def resolve_asset(version: dict) -> None:
    asset_id = version.get("asset_id")
    if not asset_id:
        raise RuntimeError("Selected Camoufox version has no GitHub asset id")

    repo = os.environ.get("CAMOUFOX_API_ASSET_REPO", "daijro/camoufox")
    api_url = f"https://api.github.com/repos/{repo}/releases/assets/{asset_id}"
    response = requests.head(
        api_url,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": "onegl-camoufox-build",
        },
        allow_redirects=True,
        timeout=60,
    )
    response.raise_for_status()
    if "release-assets.githubusercontent.com" not in response.url:
        raise RuntimeError(f"Unexpected Camoufox asset redirect: {response.url}")
    version["_onegl_original_url"] = version.get("url")
    version["url"] = response.url
    print(
        "Resolved Camoufox asset URL for "
        f"{version.get('version')}-{version.get('build')} via GitHub API"
    )


def restore_asset(version: dict) -> None:
    original = version.pop("_onegl_original_url", None)
    if original:
        version["url"] = original
        print("Restored the public Camoufox asset URL in repo_cache.json")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--restore", action="store_true")
    args = parser.parse_args()

    path = cache_path()
    cache = load_cache(path)
    _repo, version = selected_version(cache)
    if args.restore:
        restore_asset(version)
    else:
        resolve_asset(version)
    save_cache(path, cache)


if __name__ == "__main__":
    main()
