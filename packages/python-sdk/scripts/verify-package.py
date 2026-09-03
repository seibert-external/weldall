#!/usr/bin/env python3
"""Validate Python SDK wheel/sdist contents without extracting them."""

from __future__ import annotations

import argparse
import tarfile
import zipfile
from pathlib import Path


def validate_wheel(path: Path, expected_license: bytes) -> None:
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        license_name = require_suffix(names, ".dist-info/licenses/LICENSE", path)
        if archive.read(license_name) != expected_license:
            raise SystemExit(f"{path}: packaged LICENSE differs from source")
    require_suffix(names, "weldall/py.typed", path)
    reject_debris(names, path)


def validate_sdist(path: Path, expected_license: bytes) -> None:
    with tarfile.open(path, "r:gz") as archive:
        names = set(archive.getnames())
        license_name = require_suffix(names, "/LICENSE", path)
        member = archive.extractfile(license_name)
        if member is None or member.read() != expected_license:
            raise SystemExit(f"{path}: packaged LICENSE differs from source")
    require_suffix(names, "/src/weldall/py.typed", path)
    require_suffix(names, "/uv.lock", path)
    reject_debris(names, path)


def require_suffix(names: set[str], suffix: str, path: Path) -> str:
    matches = [name for name in names if name.endswith(suffix)]
    if len(matches) != 1:
        raise SystemExit(f"{path}: expected exactly one {suffix}")
    return matches[0]


def reject_debris(names: set[str], path: Path) -> None:
    forbidden = ("/__pycache__/", "/.pytest_cache/", "/dist/", "/tests/")
    found = sorted(name for name in names if any(item in f"/{name}" for item in forbidden))
    if found:
        raise SystemExit(f"{path}: contains build/test debris: {found[:5]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifacts", nargs="+", type=Path)
    paths = parser.parse_args().artifacts
    wheels = [path for path in paths if path.suffix == ".whl"]
    sdists = [path for path in paths if path.name.endswith(".tar.gz")]
    if len(wheels) != 1 or len(sdists) != 1:
        raise SystemExit("expected exactly one wheel and one .tar.gz sdist")
    expected_license = (Path(__file__).resolve().parents[1] / "LICENSE").read_bytes()
    validate_wheel(wheels[0], expected_license)
    validate_sdist(sdists[0], expected_license)
    print(f"verified {wheels[0].name} and {sdists[0].name}")


if __name__ == "__main__":
    main()
