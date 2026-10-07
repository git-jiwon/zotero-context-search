# Real Zotero integration checks

Run from the project directory with Python 3 and the installed Zotero 10 executable:

```powershell
python scripts/run-integration.py --locale ko-KR --xpi dist/zotero-context-search-1.0.0.xpi
python scripts/run-integration.py --locale en-US --xpi dist/zotero-context-search-1.0.0.xpi
```

The runner creates a fresh profile, data directory, synthetic two-page PDF, and test-only addon beneath `tests/.runs/<run ID>`. The test addon refuses to run unless both active paths match that run and its marker file exists. It does not use a signed-in account or the user's Zotero library. Preferences disable automatic synchronization and Word/LibreOffice integration installation in the test profile.

Run both locale commands to check the actual Korean and English interfaces. `--locale` sets Zotero's requested application language in the isolated profile; it defaults to `ko-KR`. Omit `--xpi` to test the current source addon. Each run records the requested language and checks Zotero's actual locale before testing translated controls and messages. Completed results, including the tested package hash, belong in the [verification report](../docs/VERIFICATION.md).

The checks use Zotero's real PDF text index, database, native quick-search field, inline results, item tree, preference pane, and PDF reader. Search runs in the existing Zotero window. Clearing the query restores the native item list.

The current checks cover:

- Literal matches with surrounding text, metadata display, collection/tag scope, cancellation, and pagination.
- Exact full-phrase ranking across the candidate set before pagination, and a later full-phrase passage becoming the first snippet. Native candidate scope remains intact.
- Native and inline favorite buttons, the exact `★` tag, preservation of other tags, and disclosure arrows when the favorite column is moved to the first position.
- Citation preferences, custom starting numbers, inherited long format with all authors and title, and delegation of native long citations to the configured Zotero Quick Copy CSL style.
- Native context menu order: short citation, long citation, original file copy.
- Korean and English search controls, metadata field labels, favorites, settings, accessibility labels, status messages, and validation errors. Citation content and its CSL language remain independent of the UI language.
- Search-result titles open the actual matching PDF when a reference has multiple attachments. Returning from the reader preserves the query and results; records without files fall back to the native list.
- **Show in Library / 서지목록에서 보기** aligns a middle row at the top of a scrolled native list, preserving the complete item order, sort direction, and collection. Unit tests also cover sticky headers and a new query or collection selection arriving during navigation.
- Resolution of original local files to actual `nsIFile` objects. Parent items prefer PDFs; an explicitly selected attachment keeps its own file.

Automated tests **never read or write the real operating-system clipboard**. They replace the clipboard output boundary with test functions, then inspect citation text, native CSL call arguments, and resolved file objects. Node tests validate the Windows `CF_HDROP` UTF-16 file-list buffer and memory ownership on success and failure. An integration test may load the bundled ctypes bindings and allocate/free a buffer without calling clipboard open, clear, or write functions. Actual paste into Explorer, email, and PowerPoint is outside this automated scope. Cloud synchronization is also not exercised.

Each run retains `run.json`, `result.json`, `process.log`, and screenshots such as `native-library.png`, `inline-search.png`, and `native-restored.png` for review. Newer runs also capture the citation preferences and phrase-ranked search results. Inspect that run's files for the complete screenshot list. With `--xpi`, `run.json` records the release file's SHA-256. Screenshots are rendered directly from isolated Zotero windows, so they exclude other applications.

The test addon requests application shutdown when finished. The runner also checks the exact unique test-profile command-line argument before closing any remaining Windows Zotero process. It never closes Zotero by executable name. `--keep-open` leaves that test instance available for visual review; close the isolated test window afterwards.

## PDF page locations

Page-location checks must use synthetic PDFs and Zotero's existing extracted-text cache. Verify physical page numbers, a match spanning pages, and opening the first matching page through the native PDF reader. Both interface languages use `PDF p. 3` for one page and `PDF pp. 3–4` for a range. Missing page data or inconsistent indexing statistics must produce the generic **PDF text / PDF 본문** label rather than a guessed page. These checks must not add PDF parsing, OCR, or reindexing to the plugin.

The cache and reader assertions actually completed for a release belong in [VERIFICATION.md](../docs/VERIFICATION.md), with the tested XPI's SHA-256. Test instructions here are not a record of a successful run.

## Restart and sidebar layout

```powershell
python scripts/run-restart.py --xpi dist/zotero-context-search-1.0.0.xpi
```

This separate runner creates a synthetic library and isolated profile under `tests/.runs/`, then launches Zotero twice using that same profile. The test addon validates the marker, profile, and data paths before changing preferences, writing data, or requesting shutdown. It does not use your normal Zotero library, account, or clipboard.

The 14 assertions across both launches check that search keeps the collection and item sidebars in place, long fictional metadata stays within the results pane, saved widths survive a real process restart, and clearing the search restores the native list. Example widths are set only by the fixture in the isolated profile. The plugin does not set sidebar widths; it contains its results within Zotero's existing layout.

Review `restart-phase-1.json`, `restart-phase-2.json`, their screenshots, and the process logs in the run directory. The runner allows Zotero to save its state before launching the second process. Any remaining test process is closed only after verifying its exact isolated-profile argument.

Only the reviewed `addon/` files and the root `LICENSE` belong in the release XPI. The fixture runner and integration addon must not be included.


Always match the run's checksum to the package being released.

Current release results: [Release verification](../docs/VERIFICATION.md).
