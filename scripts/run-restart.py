"""Check sidebar geometry across two isolated Zotero processes; never use a real profile."""
from __future__ import annotations
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("zcs_integration", ROOT / "scripts" / "run-integration.py")
integration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(integration)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zotero", default=r"C:\Program Files\Zotero\zotero.exe")
    parser.add_argument("--xpi", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=100)
    args = parser.parse_args()
    if not Path(args.zotero).is_file() or not args.xpi.is_file():
        parser.error("Both the installed Zotero executable and built XPI must exist")
    name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ-restart-") + uuid.uuid4().hex[:6]
    run = ROOT / "tests" / ".runs" / name
    profile, data = run / "profile", run / "data"
    extensions = profile / "extensions"
    extensions.mkdir(parents=True)
    data.mkdir()
    (run / ".context-search-isolated-test").write_text("Synthetic restart checks only\n")
    shutil.copyfile(args.xpi, extensions / "context-search@local.zotero.xpi")
    shutil.copytree(ROOT / "tests" / "restart-addon", extensions / "context-search-restart-tests@local.zotero")
    settings = {
        "extensions.zotero.useDataDir": True, "extensions.zotero.dataDir": str(data),
        "extensions.zotero.contextSearch.integrationRoot": str(run),
        "extensions.zotero.firstRun2": False, "extensions.zotero.firstRunGuidance": False,
        "extensions.zotero.showPostUpgradeBanner": False,
        "extensions.zotero.sync.reminder.setUp.enabled": False,
        "extensions.zotero.sync.reminder.autoSync.enabled": False,
        "extensions.zotero.sync.autoSync": False, "extensions.zotero.httpServer.enabled": False,
        "extensions.zotero.automaticScraperUpdates": False,
        "extensions.zoteroWinWordIntegration.skipInstallation": True,
        "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
        "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15,
        "extensions.startupScanScopes": 15, "extensions.update.enabled": False,
        "extensions.getAddons.cache.enabled": False, "xpinstall.signatures.required": False,
        "app.update.auto": False, "app.update.enabled": False,
        "toolkit.telemetry.enabled": False, "datareporting.healthreport.uploadEnabled": False,
    }
    (profile / "user.js").write_text("\n".join(
        f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in settings.items()), encoding="utf-8")
    command = [args.zotero, "-no-remote", "-profile", str(profile), "-datadir", str(data)]
    startup = None
    if os.name == "nt":
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
    print(json.dumps({"runDirectory": str(run)}), flush=True)
    for phase in (1, 2):
        result = run / f"restart-phase-{phase}.json"
        with (run / f"process-{phase}.log").open("wb") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, startupinfo=startup)
            try:
                deadline = time.monotonic() + args.timeout
                while not result.is_file() and time.monotonic() < deadline:
                    time.sleep(0.5)
                if not result.is_file():
                    raise RuntimeError(f"Restart phase {phase} timed out; inspect {run}")
                report = json.loads(result.read_text(encoding="utf-8"))
                print(json.dumps(report, ensure_ascii=False), flush=True)
                # Allow Zotero's own shutdown to persist layout before the next launch.
                time.sleep(3)
                if not report.get("passed"):
                    return 1
            finally:
                integration.close_test_process(process, profile)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
