"""Release packaging tests. Run: python -m unittest discover -s tests -p '*_test.py'."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("zcs_build", ROOT / "scripts" / "build.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class ReleaseBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="zcs-build-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = {
            "manifest_version": 2, "name": "Fixture", "version": "1.0.0",
            "homepage_url": "https://github.com/git-jiwon/zotero-context-search",
            "applications": {"zotero": {
                "id": "context-search@local.zotero", "strict_min_version": "9.0", "strict_max_version": "*",
                "update_url": "https://github.com/git-jiwon/zotero-context-search/releases/latest/download/updates.json",
            }},
        }
        for name in builder.ADDON_FILES:
            path = self.root / "addon" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture\r\n" if path.suffix != ".png" else b"\x89PNG\r\n\x1a\nfixture")
        (self.root / "LICENSE").write_bytes(b"MIT License\r\nSynthetic contributors\r\n")
        self.write_metadata()

    def write_metadata(self, package_version="1.0.0"):
        (self.root / "addon" / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        (self.root / "package.json").write_text(json.dumps({"version": package_version}), encoding="utf-8")

    def test_repeated_build_preserves_bytes_license_and_update_hash(self):
        first = builder.build(self.root)
        original = first["xpi"].read_bytes()
        # A source's mtime and Windows/Unix checkout newlines must not affect output.
        source = self.root / "addon" / "bootstrap.js"
        source.write_bytes(b"fixture\n")
        os.utime(source, (1_000_000_000, 1_000_000_000))
        second = builder.build(self.root)
        self.assertEqual(second["xpi"].read_bytes(), original)
        self.assertEqual(first["sha256"], hashlib.sha256(original).hexdigest())
        with zipfile.ZipFile(first["xpi"]) as archive:
            self.assertEqual(len(archive.infolist()), 21)
            self.assertEqual(set(archive.namelist()), set(builder.ADDON_FILES) | {"LICENSE"})
            self.assertEqual(archive.namelist(), sorted(archive.namelist()))
            self.assertEqual(archive.read("LICENSE"), b"MIT License\nSynthetic contributors\n")
            self.assertTrue(all(entry.date_time == builder.ZIP_TIME and entry.create_system == 3 for entry in archive.infolist()))
            self.assertIsNone(archive.testzip())
        update = json.loads(first["updates"].read_text())["addons"]["context-search@local.zotero"]["updates"][0]
        self.assertEqual(update["version"], "1.0.0")
        self.assertEqual(update["update_hash"], "sha256:" + first["sha256"])
        self.assertEqual(update["update_link"], "https://github.com/git-jiwon/zotero-context-search/releases/download/v1.0.0/zotero-context-search-1.0.0.xpi")
        self.assertEqual(update["applications"], {"zotero": {"strict_min_version": "9.0", "strict_max_version": "*"}})
        self.assertEqual(first["checksum"].read_text(), first["sha256"] + "  zotero-context-search-1.0.0.xpi\n")

    def test_unexpected_addon_files_and_missing_files_are_rejected(self):
        extra = self.root / "addon" / "private-notes.txt"
        extra.write_text("must never be packaged")
        with self.assertRaisesRegex(builder.BuildError, "Unexpected"):
            builder.build(self.root)
        self.assertFalse((self.root / "dist").exists())
        extra.unlink()
        (self.root / "addon" / "content" / "citation.js").unlink()
        with self.assertRaisesRegex(builder.BuildError, "Missing release files"):
            builder.build(self.root)

    def test_invalid_versions_mismatch_and_wrong_update_origin_are_rejected(self):
        for version in ("../1.0.0", "1.0", "01.0.0", "1.0.0/../../escape", "1.0.0\n"):
            with self.subTest(version=version):
                self.manifest["version"] = version
                self.write_metadata(version)
                with self.assertRaisesRegex(builder.BuildError, "MAJOR.MINOR.PATCH"):
                    builder.build(self.root)
        self.manifest["version"] = "1.0.0"
        self.write_metadata("1.0.1")
        with self.assertRaisesRegex(builder.BuildError, "versions must match"):
            builder.build(self.root)
        self.manifest["applications"]["zotero"]["update_url"] = "https://example.invalid/updates.json"
        self.write_metadata()
        with self.assertRaisesRegex(builder.BuildError, "update_url"):
            builder.build(self.root)

    def test_source_paths_cannot_escape_the_project(self):
        for relative in ("../private.txt", "/etc/passwd", "C:/Users/private.txt", "addon/../LICENSE", "addon\\manifest.json"):
            with self.subTest(relative=relative):
                with self.assertRaisesRegex(builder.BuildError, "inside the project"):
                    builder.safe_source(self.root, relative)
        self.manifest["homepage_url"] = "https://github.com/owner/../outside"
        self.write_metadata()
        with self.assertRaisesRegex(builder.BuildError, "GitHub owner/repository"):
            builder.build(self.root)

    def test_source_and_output_links_are_rejected(self):
        outside = self.root / "outside.txt"
        outside.write_text("private fixture")
        source = self.root / "addon" / "bootstrap.js"
        source.unlink()
        try:
            source.symlink_to(outside)
        except OSError as error:
            if os.name == "nt":
                # Windows file symlinks require privileges. Directory junctions
                # exercise the real reparse-point boundary without elevation.
                source.write_text("fixture\n")
                return self.check_windows_junctions()
            self.skipTest(f"OS does not permit symbolic-link fixtures: {error}")
        with self.assertRaisesRegex(builder.BuildError, "Links and Windows reparse"):
            builder.build(self.root)
        source.unlink()
        source.write_text("fixture\n")
        dist = self.root / "dist"
        dist.mkdir()
        (dist / "zotero-context-search-1.0.0.xpi").symlink_to(outside)
        with self.assertRaisesRegex(builder.BuildError, "Links and Windows reparse"):
            builder.build(self.root)
        self.assertEqual(outside.read_text(), "private fixture")

    def check_windows_junctions(self):
        outside = self.root / "outside-directory"
        outside.mkdir()
        private_file = outside / "private.txt"
        private_file.write_text("private fixture")

        def junction(path):
            subprocess.run([
                "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                "New-Item -ItemType Junction -Path $env:ZCS_BUILD_TEST_LINK -Target $env:ZCS_BUILD_TEST_TARGET | Out-Null",
            ], env=dict(os.environ, ZCS_BUILD_TEST_LINK=str(path), ZCS_BUILD_TEST_TARGET=str(outside)),
                check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)

        content = self.root / "addon" / "content"
        saved = self.root / "original-content"
        content.rename(saved)
        junction(content)
        try:
            with self.assertRaisesRegex(builder.BuildError, "Links and Windows reparse"):
                builder.build(self.root)
        finally:
            content.rmdir()  # Remove only this test-created junction, not its target.
            saved.rename(content)
        dist = self.root / "dist"
        junction(dist)
        try:
            with self.assertRaisesRegex(builder.BuildError, "Links and Windows reparse"):
                builder.build(self.root)
        finally:
            dist.rmdir()
        self.assertEqual(private_file.read_text(), "private fixture")


if __name__ == "__main__":
    unittest.main()
