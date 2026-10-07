# Security review for 1.0.0

Review dates: 2026-10-03 and 2026-10-04. This records a scoped source review and regression checks. It is not an independent certification or a guarantee of security.

## Scope

The review covered library text handling, native search scope, cancellation, favorites, citation and file clipboard operations, add-on lifecycle, release packaging, and isolation of the test harness. Library metadata, note markup, extracted text, and attachment paths were treated as untrusted input.

This is a privileged Zotero add-on. The review does not establish the security of Zotero, its CSL/PDF engines, Windows, other installed add-ons, or applications receiving clipboard data.

## Changes made during review

- **Malformed note markup:** repeated unmatched tags could cause repeated regular-expression scans. `snippets.js` now scans markup forward, preserves inert text, and omits script/style content without creating a live HTML document.
- **Large and repetitive text:** full-document normalization maps and accumulated match lists could exhaust memory or keep the UI busy. Matching now uses overlapping 32 KiB chunks, bounded candidate excerpts, and bounded sentence neighborhoods. It continues across the text so a complete phrase near the end can outrank earlier partial matches. Asynchronous scanning yields and checks cancellation between chunks, including within one large PDF or metadata field.
- **Malformed citation formatting tags:** the formatting-tag expression now stops at either angle bracket. Repeated incomplete `<span` tags remain literal text instead of triggering repeated scans through the remaining field.
- **Displayed metadata:** highlighting in result titles and metadata is limited to 4,096 UTF-16 code units, with an ellipsis and a check to avoid cutting a surrogate pair. This limits display work; full-text search and citation copying still use the complete stored values. Precomputed snippets use their separate excerpt limits.
- **Release contents:** `scripts/build.py` packages an explicit set of 20 add-on files plus `LICENSE`. It rejects unexpected add-on files, traversal paths, symlinks, and Windows reparse points in inspected source/output paths. It checks version agreement and repository update URLs, normalizes text line endings, fixes archive metadata, checks archive integrity, and emits a SHA-256 checksum and matching update hash. These controls reduce accidental inclusion and tampering opportunities; they do not authenticate a compromised maintainer account or build machine.
- **Test isolation:** integration data creation requires the expected profile, data directory, and marker. Result writing and application shutdown in `finally` also require successful isolation validation. Test code and synthetic data are excluded from the release archive.

## Boundaries checked

- Search terms are treated as literal text and passed through Zotero search conditions, rather than inserted into executable regular expressions or SQL. Native temporary search-table names are validated before cleanup SQL is constructed. Results remain bounded by the selected library and candidate scope.
- Search results and previews use text nodes or `textContent`; untrusted library text is not assigned as dynamic HTML. Favorite changes affect the exact `★` tag and retain unrelated tags.
- Custom citations use plain-text clipboard output. Native long citations delegate to an installed Zotero CSL style. Clipboard operations require a user command; the add-on does not read existing clipboard contents.
- Original-file copying resolves selected Zotero attachments and checks file existence/type. Directly selected attachments retain their own file. It does not execute attachments, download missing files for copying, or move/delete originals. Linked files may be outside Zotero storage, including UNC paths and mapped drives that involve operating-system network access.
- Windows multi-file copying uses a UTF-16 `CF_HDROP` buffer and a copy effect. Allocated memory transfers to Windows only after a successful clipboard write; failure paths free memory still owned by the add-on. No shell or helper process is launched. The reviewed DLL names are Windows system libraries; this is not a general facility for loading library-selected DLL paths.

## PDF page mapping

The page feature reads page counts through Zotero and checks them against the existing cache separators before displaying a page number. Missing or inconsistent counts keep the unnumbered excerpt. Mapping stores only page boundaries, preserves the existing text transformations, and does not parse or download PDFs during search. Page buttons create text nodes and pass a positive integer page location through Zotero's native attachment-opening API.

## Interface language

UI text follows Zotero's resolved application locale, with Korean and English translations and an English fallback. Parameters are inserted as literal text. Settings localization changes only leaf labels and accessibility text, preserving input controls and listeners. The favorites header interpolates only fixed translated labels. Imported bibliographic text, the stored `★` tag, and Zotero's CSL locale are not translated.

## Validation and remaining limits

Regression tests cover malformed markup, repeated matches, late and cross-chunk phrases, cancellation, native scope, metadata display limits, file selection, clipboard payloads, memory ownership, and release packaging. The final test counts and release artifact evidence are recorded in the [verification report](VERIFICATION.md).

The original cached text is still read into memory, and initial text cleanup remains proportional to its size. Chunked matching is not a hard bound on total process memory or runtime for arbitrarily large libraries. Native Zotero operations may also take time outside the add-on's cancellation points.

Windows system DLLs are loaded by name, relying on the operating system's DLL resolution. This review found no demonstrated search-path hijack for the two system libraries used; it does not establish the integrity of the host's loader or system files.

Automated tests replace clipboard output with test functions. Native transferable construction and Windows memory allocation are checked, but real paste behavior and every receiving application are outside this review. Runtime testing has used Zotero 10.0.5 on Windows; the Zotero 9+ installation range does not imply that all versions and platforms were tested.

See [Privacy](PRIVACY.md) for GitHub update requests, Zotero synchronization/downloads, and network-file behavior. Report concerns using the [security policy](../SECURITY.md).
