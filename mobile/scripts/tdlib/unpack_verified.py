#!/usr/bin/env python3
"""Safely unpack a successful trusted-main TDLib source-build artifact.

Do not use tarfile.extractall on a remote archive. The binary checksum and
upstream-source pin are checked separately by bundle.cjs before staging.
"""
from __future__ import annotations
import pathlib
import shutil
import sys
import tarfile

DIRS = {
    "bundle", "bundle/libs", "bundle/libs/arm64-v8a",
    "bundle/libs/x86_64", "bundle/java", "bundle/java/org",
    "bundle/java/org/drinkless", "bundle/java/org/drinkless/tdlib",
}
REQUIRED = {
    "bundle/manifest.json",
    "bundle/libs/arm64-v8a/libtdjsonjava.so",
    "bundle/libs/x86_64/libtdjsonjava.so",
    "bundle/java/org/drinkless/tdlib/JsonClient.java",
}
EXTRA = {
    "bundle/SHA256SUMS",
    "bundle/arm64-v8a-ELF-program-headers.txt",
    "bundle/x86_64-ELF-program-headers.txt",
}


def unpack(archive: str, destination: str) -> None:
    root = pathlib.Path(destination).resolve()
    if root.exists() and any(root.iterdir()):
        raise ValueError("tdlib_unpack_destination_not_empty")
    root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        names: set[str] = set()
        if not members or len(members) > 25:
            raise ValueError("tdlib_archive_member_count")
        for entry in members:
            name = entry.name.rstrip("/")
            if name in names:
                raise ValueError("tdlib_archive_duplicate")
            names.add(name)
            if name in DIRS and entry.isdir():
                continue
            if name not in (REQUIRED | EXTRA) or not entry.isfile():
                raise ValueError("tdlib_archive_unsafe_entry")
            ceiling = 120 * 1024 * 1024 if name.endswith(".so") else 1024 * 1024
            if entry.size <= 0 or entry.size > ceiling:
                raise ValueError("tdlib_archive_size")
        if not REQUIRED.issubset(names):
            raise ValueError("tdlib_archive_missing_component")
        for entry in members:
            name = entry.name.rstrip("/")
            target = root.joinpath(*name.split("/"))
            if entry.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                stream = source.extractfile(entry)
                if stream is None:
                    raise ValueError("tdlib_archive_unreadable")
                with stream, target.open("xb") as handle:
                    shutil.copyfileobj(stream, handle, length=128 * 1024)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: unpack_verified.py source.tar.gz target-directory")
    unpack(sys.argv[1], sys.argv[2])
    print("TDLib archive entries validated and extracted (cryptographic verification follows)")
