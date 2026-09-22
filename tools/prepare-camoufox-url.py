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
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
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


def install_selected(repo: dict, version: dict) -> None:
    from camoufox.pkgman import AvailableVersion, CamoufoxFetcher, RepoConfig, Version

    repo_config = RepoConfig.find_by_name(repo["name"])
    if repo_config is None:
        raise RuntimeError(f"Camoufox repository is not configured: {repo['name']}")
    selected = AvailableVersion(
        version=Version(build=version["build"], version=version["version"]),
        url=version["url"],
        is_prerelease=bool(version.get("is_prerelease")),
        asset_id=version.get("asset_id"),
        asset_size=version.get("asset_size"),
        asset_updated_at=version.get("asset_updated_at"),
    )
    # Camoufox's built-in downloader is deliberately simple and uses one
    # connection. Release assets are large, so use ranged requests here while
    # retaining Camoufox's own extraction, metadata, and activation logic.
    CamoufoxFetcher.download_file = staticmethod(download_parallel)
    CamoufoxFetcher(repo_config=repo_config, selected_version=selected).install()


def restore_asset(version: dict) -> None:
    original = version.pop("_onegl_original_url", None)
    if original:
        version["url"] = original
        print("Restored the public Camoufox asset URL in repo_cache.json")


def download_parallel(buffer, url: str):
    """Download a large release asset with ranged requests, then join it."""
    head = requests.head(url, allow_redirects=True, timeout=60)
    head.raise_for_status()
    total = int(head.headers.get("content-length", "0"))
    if total <= 0:
        raise RuntimeError("Camoufox asset did not provide a content length")

    part_size = int(os.environ.get("CAMOUFOX_DOWNLOAD_PART_SIZE", 16 * 1024 * 1024))
    workers = max(2, min(16, int(os.environ.get("CAMOUFOX_DOWNLOAD_WORKERS", "8"))))
    ranges = [
        (start, min(start + part_size - 1, total - 1))
        for start in range(0, total, part_size)
    ]
    print(f"Downloading Camoufox asset in {len(ranges)} ranges with {workers} workers")

    parts_dir = Path(tempfile.mkdtemp(prefix="camoufox-parts-"))

    def fetch_part(index: int, start: int, end: int) -> Path:
        path = parts_dir / f"{index:04d}.part"
        result = subprocess.run(
            [
                "curl",
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--retry",
                "3",
                "--retry-delay",
                "2",
                "--connect-timeout",
                "60",
                "--max-time",
                "900",
                "--header",
                "Accept-Encoding: identity",
                "--range",
                f"{start}-{end}",
                "--output",
                str(path),
                url,
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            detail = (result.stderr or "curl failed").strip()
            raise RuntimeError(f"Camoufox range download failed: {detail[-400:]}")
        expected = end - start + 1
        received = path.stat().st_size if path.exists() else 0
        if received != expected:
            raise RuntimeError(
                f"Camoufox range {start}-{end} was truncated: {received}/{expected} bytes"
            )
        return path

    try:
        completed = {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(fetch_part, index, start, end): index
                for index, (start, end) in enumerate(ranges)
            }
            for future in as_completed(futures):
                index = futures[future]
                completed[index] = future.result()

        buffer.seek(0)
        buffer.truncate(0)
        for index in range(len(ranges)):
            with completed[index].open("rb") as part:
                shutil.copyfileobj(part, buffer, length=1024 * 1024)
        buffer.seek(0)
        return buffer
    finally:
        shutil.rmtree(parts_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--restore", action="store_true")
    args = parser.parse_args()

    path = cache_path()
    cache = load_cache(path)
    repo, version = selected_version(cache)
    if args.restore:
        restore_asset(version)
    else:
        resolve_asset(version)
        if args.install:
            save_cache(path, cache)
            install_selected(repo, version)
    save_cache(path, cache)


if __name__ == "__main__":
    main()
