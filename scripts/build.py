"""Build a reproducible release XPI and its Zotero update manifest, without downloads."""
from __future__ import annotations

import hashlib
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
from urllib.parse import urlsplit
import zipfile


ADDON_FILES = (
    "bootstrap.js", "manifest.json",
    "content/citation.js", "content/controller.js", "content/favorites.js",
    "content/file-copy.js", "content/inline-ui.js", "content/localization.js", "content/preferences.css",
    "content/preferences.js", "content/preferences.xhtml", "content/search.js", "content/snippets.js",
    "icons/icon.svg", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-96.png", "icons/icon-128.png",
    "locale/en-US/context-search.ftl", "locale/ko-KR/context-search.ftl",
)
ZIP_TIME = (2026, 10, 3, 0, 0, 0)
# Published stable releases use MAJOR.MINOR.PATCH, without leading zeroes.
RELEASE_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")
TEXT_SUFFIXES = {".js", ".json", ".css", ".xhtml", ".svg", ".ftl"}


class BuildError(ValueError):
    """The source tree does not satisfy the release packaging rules."""


def _reject_link(path: Path) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise BuildError(f"Links and Windows reparse points are not allowed: {path}")


def safe_source(root: Path, relative: str) -> Path:
    """Validate every existing path component before reading a source file."""
    root = Path(root).resolve(strict=True)
    name = PurePosixPath(relative)
    if not relative or name.is_absolute() or ".." in name.parts or "\\" in relative or ":" in relative:
        raise BuildError(f"Source path must stay inside the project: {relative}")
    source = root
    for part in name.parts:
        source = source / part
        _reject_link(source)
    if not source.resolve(strict=True).is_relative_to(root) or not source.is_file():
        raise BuildError(f"Expected an ordinary file inside the project: {relative}")
    return source


def _validate_addon_tree(root: Path) -> None:
    addon = root / "addon"
    _reject_link(addon)
    if not addon.is_dir():
        raise BuildError("addon must be an ordinary directory")
    allowed = set(ADDON_FILES)
    directories = {str(parent) for name in allowed for parent in PurePosixPath(name).parents if str(parent) != "."}
    found = set()
    pending = [addon]
    while pending:
        for path in pending.pop().iterdir():
            _reject_link(path)
            relative = path.relative_to(addon).as_posix()
            if path.is_dir() and relative in directories:
                pending.append(path)
            elif path.is_file() and relative in allowed:
                safe_source(root, "addon/" + relative)
                found.add(relative)
            else:
                raise BuildError(f"Unexpected path in addon; review the release allowlist: {relative}")
    missing = allowed - found
    if missing:
        raise BuildError("Missing release files: " + ", ".join(sorted(missing)))


def _metadata(root: Path) -> tuple[dict, str]:
    manifest = json.loads(safe_source(root, "addon/manifest.json").read_text(encoding="utf-8"))
    package = json.loads(safe_source(root, "package.json").read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not isinstance(version, str) or not RELEASE_VERSION.fullmatch(version):
        raise BuildError("Release version must be MAJOR.MINOR.PATCH without leading zeroes")
    if package.get("version") != version:
        raise BuildError("package.json and addon/manifest.json versions must match")
    homepage = manifest.get("homepage_url", "").rstrip("/")
    url = urlsplit(homepage)
    parts = url.path.strip("/").split("/")
    if (url.scheme != "https" or url.netloc != "github.com" or url.query or url.fragment
            or len(parts) != 2 or any(not re.fullmatch(r"[A-Za-z0-9_.-]+", part) or part in {".", ".."} for part in parts)):
        raise BuildError("homepage_url must identify an HTTPS GitHub owner/repository")
    application = manifest.get("applications", {}).get("zotero", {})
    if not application.get("id") or not application.get("strict_min_version"):
        raise BuildError("Zotero add-on ID and minimum version are required")
    expected_updates = homepage + "/releases/latest/download/updates.json"
    if application.get("update_url") != expected_updates:
        raise BuildError("update_url must use this repository's releases/latest/download/updates.json")
    return manifest, homepage


def _source_bytes(source: Path) -> bytes:
    data = source.read_bytes()
    # Git checkout settings must not change release bytes between Windows and CI.
    if source.name == "LICENSE" or source.suffix in TEXT_SUFFIXES:
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return data


def _write_output(target: Path, content: bytes) -> None:
    if target.exists() or target.is_symlink():
        _reject_link(target)
        if not target.is_file():
            raise BuildError(f"Output target is not a file: {target}")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".zcs-build-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            output.write(content)
        os.replace(temporary, target)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def build(project_root: Path | str | None = None) -> dict:
    root = Path(project_root or Path(__file__).resolve().parents[1]).resolve(strict=True)
    manifest, homepage = _metadata(root)
    _validate_addon_tree(root)
    sources = {name: safe_source(root, "addon/" + name) for name in ADDON_FILES}
    sources["LICENSE"] = safe_source(root, "LICENSE")
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, source in sorted(sources.items()):
            entry = zipfile.ZipInfo(name, ZIP_TIME)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(entry, _source_bytes(source), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(BytesIO(buffer.getvalue())) as archive:
        if archive.testzip() is not None or set(archive.namelist()) != set(sources):
            raise BuildError("Release archive validation failed")
    archive_bytes = buffer.getvalue()
    digest = hashlib.sha256(archive_bytes).hexdigest()
    name = f'zotero-context-search-{manifest["version"]}.xpi'
    application = manifest["applications"]["zotero"]
    compatibility = {key: application[key] for key in ("strict_min_version", "strict_max_version") if key in application}
    updates = {"addons": {application["id"]: {"updates": [{
        "version": manifest["version"],
        "update_link": f'{homepage}/releases/download/v{manifest["version"]}/{name}',
        "update_hash": "sha256:" + digest,
        "applications": {"zotero": compatibility},
    }]}}}
    dist = root / "dist"
    if dist.exists() or dist.is_symlink():
        _reject_link(dist)
        if not dist.is_dir():
            raise BuildError("dist must be an ordinary directory")
    else:
        dist.mkdir()
    target = dist / name
    checksum = target.with_suffix(".xpi.sha256")
    update_manifest = dist / "updates.json"
    _write_output(target, archive_bytes)
    _write_output(checksum, f"{digest}  {name}\n".encode("ascii"))
    _write_output(update_manifest, (json.dumps(updates, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    return {"xpi": target, "sha256": digest, "checksum": checksum, "updates": update_manifest}


def main() -> None:
    result = build()
    print(f'{result["xpi"]}\n{result["xpi"].stat().st_size:,} bytes\nSHA256 {result["sha256"]}\n{result["updates"]}')


if __name__ == "__main__":
    main()
