"""Run the real Zotero integration checks in a new, isolated test profile.

No user profile, library, or installed extensions are read or modified. Each run
is retained under tests/.runs for review. Only the process started here is closed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def make_pdf(path: Path, pages: list[list[str]] | None = None) -> None:
    pages = pages or [
        ["Fictional article created to demonstrate context search.",
         "Before the match: this paragraph introduces the fictional example.",
         "An example passage contains a sample phrase for the search preview.",
         "After the match: this sentence shows the surrounding context."],
        ["Second page of this fictional example article.",
         "Before the second match: check the page boundary.",
         "Another SAMPLE appears in a fictional paragraph.",
         "After the second match: this is another context preview."],
    ]
    objects: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>",
                          b"<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
                          b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    for i, lines in enumerate(pages):
        stream_id = 5 + i * 2
        objects.append((f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                        f"/Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>").encode())
        operations = ["BT", "/F1 12 Tf", "50 720 Td", "18 TL"]
        for n, line in enumerate(lines):
            if n:
                operations.append("T*")
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            operations.append(f"({escaped}) Tj")
        operations.append("ET")
        stream = "\n".join(operations).encode("ascii")
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    data = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, body in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{index} 0 obj\n".encode() + body + b"\nendobj\n")
    startxref = len(data)
    data.extend(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        data.extend(f"{offset:010} 00000 n \n".encode())
    data.extend((f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\n"
                 f"startxref\n{startxref}\n%%EOF\n").encode())
    path.write_bytes(data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zotero", default=r"C:\Program Files\Zotero\zotero.exe")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--keep-open", action="store_true")
    parser.add_argument("--locale", choices=("ko-KR", "en-US"), default="ko-KR",
                        help="Zotero application language selected before the isolated process starts")
    parser.add_argument("--xpi", type=Path, help="Test this packaged release XPI instead of the source addon directory")
    args = parser.parse_args()
    if not Path(args.zotero).is_file():
        parser.error("Zotero executable was not found")
    if args.xpi and not args.xpi.is_file():
        parser.error("Release XPI was not found")
    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + args.locale + "-" + uuid.uuid4().hex[:6]
    run_dir = ROOT / "tests" / ".runs" / run_id
    profile = run_dir / "profile"
    data_dir = run_dir / "data"
    extensions = profile / "extensions"
    extensions.mkdir(parents=True)
    data_dir.mkdir()
    (run_dir / ".context-search-isolated-test").write_text("Synthetic Zotero test only\n")
    make_pdf(run_dir / "fixture.pdf")
    make_pdf(run_dir / "fixture-phrase.pdf", [
        ["Earlier isolated sample discussion.", "The phrase appears elsewhere as a partial match."] * 12,
        ["Before the complete phrase: precise context matters.",
         "This Sample Phrase illustrates a complete match in a fictional article.",
         "After the complete phrase: this is the relevant passage."],
    ])
    for source, addon_id in [(ROOT / "addon", "context-search@local.zotero"),
                             (ROOT / "tests" / "integration-addon", "context-search-tests@local.zotero")]:
        if args.xpi and addon_id == "context-search@local.zotero":
            shutil.copyfile(args.xpi, extensions / (addon_id + ".xpi"))
            continue
        if not (source / "manifest.json").is_file():
            raise RuntimeError(f"Missing addon manifest: {source}")
        shutil.copytree(source, extensions / addon_id)
    settings = {
        "intl.locale.requested": args.locale,
        "extensions.zotero.useDataDir": True,
        "extensions.zotero.dataDir": str(data_dir),
        "extensions.zotero.contextSearch.integrationRoot": str(run_dir),
        "extensions.zotero.contextSearch.integrationKeepOpen": args.keep_open,
        "extensions.zotero.contextSearch.integrationLocale": args.locale,
        "extensions.zotero.firstRun2": False,
        "extensions.zotero.firstRunGuidance": False,
        "extensions.zotero.showPostUpgradeBanner": False,
        "extensions.zotero.autoRenameFiles.bannerShown": True,
        "extensions.zotero.sync.reminder.setUp.enabled": False,
        "extensions.zotero.sync.reminder.autoSync.enabled": False,
        "extensions.zotero.sync.autoSync": False,
        "extensions.zotero.httpServer.enabled": False,
        "extensions.zotero.reportTranslationFailure": False,
        "extensions.zoteroWinWordIntegration.skipInstallation": True,
        "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
        "extensions.zotero.automaticScraperUpdates": False,
        "extensions.zotero.debug.store": True,
        "extensions.autoDisableScopes": 0,
        "extensions.enabledScopes": 15,
        "extensions.startupScanScopes": 15,
        "extensions.logging.enabled": True,
        "extensions.update.enabled": False,
        "extensions.getAddons.cache.enabled": False,
        "xpinstall.signatures.required": False,
        "app.update.auto": False,
        "app.update.enabled": False,
        "browser.shell.checkDefaultBrowser": False,
        "toolkit.telemetry.enabled": False,
        "datareporting.healthreport.uploadEnabled": False,
    }
    (profile / "user.js").write_text("\n".join(
        f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in settings.items()
    ), encoding="utf-8")
    command = [args.zotero, "-no-remote", "-profile", str(profile), "-datadir", str(data_dir), "-ZoteroDebugText"]
    startupinfo = None
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
    metadata = {"runDirectory": str(run_dir), "command": command, "requestedLocale": args.locale,
                "startedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    if args.xpi:
        metadata["releaseXPI"] = str(args.xpi.resolve())
        metadata["releaseSHA256"] = hashlib.sha256(args.xpi.read_bytes()).hexdigest()
    result_path = run_dir / "result.json"
    with (run_dir / "process.log").open("wb") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, startupinfo=startupinfo)
        metadata["pid"] = process.pid
        (run_dir / "run.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        print(json.dumps({"runDirectory": str(run_dir), "pid": process.pid}), flush=True)
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            if result_path.exists():
                result = json.loads(result_path.read_text(encoding="utf-8"))
                print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
                if not args.keep_open:
                    time.sleep(3)
                    close_test_process(process, profile)
                return 0 if result.get("passed") else 1
            # Windows Zotero can re-launch itself: the initial launcher PID
            # exiting does not mean the isolated browser process has exited.
            time.sleep(0.5)
        if not args.keep_open:
            close_test_process(process, profile)
        print(json.dumps({"passed": False, "error": "Integration result was not written before process exit/timeout", "runDirectory": str(run_dir)}), flush=True)
        return 1


def close_test_process(process: subprocess.Popen, profile: Path) -> None:
    if os.name == "nt":
        # Check the exact, unique test-profile argument before terminating a
        # re-launched process. Never terminate Zotero by its executable name.
        if not (profile.parent / ".context-search-isolated-test").is_file():
            raise RuntimeError("Refusing cleanup without isolated-test marker")
        script = r'''
$testPattern = '(?i)(?:^|\s)-profile\s+"?' + [regex]::Escape($env:ZCS_TEST_PROFILE) + '"?(?:\s|$)'
Get-CimInstance Win32_Process -Filter "name='zotero.exe'" |
  Where-Object { $_.CommandLine -match $testPattern } |
  ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
'''
        env = dict(os.environ, ZCS_TEST_PROFILE=str(profile.resolve()))
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                       env=env, capture_output=True, check=True)
    else:
        if process.poll() is None:
            process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
