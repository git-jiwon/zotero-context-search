# Contributing

Use Node.js 22 or newer and Python 3.10 or newer. No dependency installation is needed for normal tests or XPI builds.

```sh
node --test tests/*.test.cjs
python -m unittest discover -s tests -p '*_test.py'
python scripts/build.py
```

The build uses an explicit package file list and includes the MIT license. Unexpected files, symlinks, junctions, inconsistent versions, and unsafe version strings fail the build. Build artifacts belong in `dist/` and are release assets, not source commits.

## Real Zotero tests

On Windows with Zotero installed:

```sh
python scripts/run-integration.py --locale ko-KR --xpi dist/zotero-context-search-1.0.0.xpi
python scripts/run-integration.py --locale en-US --xpi dist/zotero-context-search-1.0.0.xpi
python scripts/run-restart.py --xpi dist/zotero-context-search-1.0.0.xpi
```

The runner creates an isolated profile and synthetic library under `tests/.runs/`. It does not use your main library, account, or operating-system clipboard. Its fixture add-on checks the profile and data paths before writing test data or requesting shutdown. These local profiles and logs must never be committed.

Run the integration checks in both languages for a release. Each run sets the requested Zotero application locale and checks the actual application locale, search controls, citation settings, menus, and messages. UI language is selected at startup; Korean uses Korean and other languages use English. Keep bibliographic metadata and CSL formatting language independent of UI translation. Both interfaces use `PDF p. 3` and `PDF pp. 3–4` page notation.

The restart runner launches Zotero twice with the same isolated profile. Its 14 assertions check saved sidebar widths, search layout with long fictional metadata, and clearing the search. The fixture sets example widths in that test profile; the plugin follows Zotero's native layout and does not set sidebar widths.

See [tests/README.md](tests/README.md) for coverage and limits. CI runs unit tests and builds; it does not run the Zotero desktop application.

## Review boundaries

- Keep item metadata and PDF/note contents as text, not HTML or executable code.
- Keep collection, library, and tag scope intact. Search and sorting must be cancellable.
- Use Zotero's existing extracted text. Avoid an additional index or model service.
- Derive physical PDF page locations from the existing cache only. Preserve safe fallback for missing or inconsistent page information; do not reparse or reindex PDFs to produce page labels.
- Translate user-facing labels, accessibility text, and messages in both Korean and English. Preserve input controls when applying translations and leave document metadata and CSL language unchanged.
- Clipboard writes must follow a user command and must not read the clipboard.
- Test against synthetic documents. Do not attach private PDFs, databases, profiles, or debug logs to public issues.
- Add regression checks for fixes affecting data, isolation, ranking, or security. Verify presentation changes in the actual Zotero layout.

## Releases

Update versions in both `package.json` and `addon/manifest.json`. Keep the plugin name **Zotero Context Search** and add-on ID `context-search@local.zotero` unchanged. Repository and release URLs use [git-jiwon/zotero-context-search](https://github.com/git-jiwon/zotero-context-search). Build twice in the same environment and compare hashes, then test that exact XPI with the Korean and English integration runs and the isolated restart runner.

Upload the XPI, its `.sha256` file, and `updates.json` to the matching GitHub release. Update metadata points to the versioned XPI URL and includes its SHA-256. Publish all assets together and record the tested artifact's checksum in the verification report.

The SVG/PNG icons are original project assets. Regenerating PNGs with `scripts/build-icons.py` is optional and requires PyMuPDF and Pillow; it is not part of the dependency-free release build.
