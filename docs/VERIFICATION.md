# v1.0.0 verification

Verified on 2026-10-04 using Windows, Zotero 10.0.5, Node.js 24.19.0, and Python 3.14.6.

| Check | Result |
| --- | --- |
| Node unit and regression tests | 146 passed |
| Python release-package tests | 5 passed |
| Real Zotero checks using the final packaged XPI, English UI | 136 passed |
| Real Zotero checks using the final packaged XPI, Korean UI | 126 passed |
| Sidebar geometry across two launches of an isolated profile | 14 passed |
| Two consecutive builds in the same environment | Identical bytes and SHA-256 |
| Archive contents | 21 reviewed files, including MIT license; CRC checks passed |
| Update metadata | Version, compatibility, version-specific download URL, and hash match XPI |

Final asset: `zotero-context-search-1.0.0.xpi`, 68,056 bytes.

```text
SHA256 82e84c1a7438648faca21ad7364a61126d1c780f332da28e9b78af3309294c39
```

## What was exercised

- Isolated runs explicitly requested `en-US` and `ko-KR` before Zotero startup and confirmed the actual application locale. Search controls, result counts, sort buttons, metadata labels, favorites, context menus, citation settings, errors, tooltips, and accessibility text matched that locale.
- English plugin UI contained no Korean text in the fictional fixture. Unit tests separately verified that Korean bibliographic metadata stays intact in the English interface and that CSL language settings are preserved.
- Both interfaces use `PDF p. 3` for a page and `PDF pp. 3–4` for a range. Unknown locations retain the localized PDF text label.

- Native PDF indexing and quick search, matching passages, collection/tag scope, and clearing back to the item list.
- Physical page 1 and 2 labels from a native two-page PDF cache; clicking the page-2 label opens the matching attachment at native pageIndex 1. Returning preserves the query and results. Missing or inconsistent page counts keep the excerpt without a page link.
- Page ranges across page breaks, Unicode cleanup, line-end hyphenation, interior blank pages, repeated passages, unavailable stats, and cache invalidation. A 6 MB / 3,000-page fixture retains accurate late-page numbering under a 96 MiB Node heap limit.
- A title click opens the actual matching second PDF when the reference has two PDFs. Returning from the reader retains the query, preview text, and result items. A record without a file returns to the native list.
- Selecting the 31st reference in an 80-item collection places it at the top of the list viewport (row index 30, scroll offset 840px). The complete row order, sort field/direction, and selected collection remain unchanged. Unit tests cover native end-of-list bounds, sticky headers, origin windows, file errors, and scope/query changes during navigation.
- Exact phrase ranking before pagination across 630 candidates; a full phrase later in the body outranks isolated title words.
- Date-added sorting in both directions, stable ties, and preference persistence.
- First-column disclosure arrows, favorite buttons, exact `★` tag, and preservation of other tags.
- Title wrapping at several widths and font sizes; metadata remains below the title. White light-theme background and compact header.
- Native sidebar geometry with long titles, abstracts, and unbroken strings. The plugin follows Zotero's saved pane widths; it does not set a sidebar width or write native layout preferences. Searching and clearing preserve the native layout, including after an actual quit and relaunch of the isolated test profile.
- Citation settings, numbering, inherited long citations, native CSL delegation, and context-menu ordering.
- Original-file resolution and native clipboard payload construction. Clipboard calls are replaced at the output boundary.
- Malformed note/citation markup, literal HTML-looking metadata, bounded visible metadata, search cancellation, chunk boundaries, and a late phrase in a 6 MB fixture under a 96 MiB Node heap limit.
- Packaging path/version checks and isolation guards. Local profiles, caches, research material, and credentials are excluded from the public source and XPI.

The [English screenshots](images/search-results-en.png) and [Korean screenshots](images/search-results.png) use fictional titles, authors, journals, and passages captured in an isolated profile. The example DOI is fictional. Test profiles and full debug logs remain local because they contain machine-specific paths.

The final packaged integration suite passed all 136 English checks and 126 Korean checks. English includes additional checks for untranslated Korean text in the plugin UI. Native bibliography checks allow CSL title casing while verifying the title, journal, year, and bibliography output. Test data is created only in a fresh isolated profile. No user library or operating-system clipboard contents are accessed.

The restart test closes the first process while search is active, then starts the same isolated profile again. It checks restored geometry, performs a new search, and clears it; it does not claim that Zotero automatically restores the search query. Synthetic pane dimensions used to establish a baseline belong only to the test addon and are excluded from the XPI.

## Page-mapping performance

A local microbenchmark compared synchronous snippet extraction with and without page mapping on the same synthetic text. Each case used three warmup pairs and seven alternating measured pairs, with one matching phrase on the final page.

| Synthetic input | Without page mapping, median | With page mapping, median |
| --- | --- | --- |
| 100 pages / 308,128 characters | 76.44 ms | 80.04 ms |
| 1,000 pages / 3,081,028 characters | 703.37 ms | 682.74 ms |

The 100-page case added about 3.60 ms. Variation in the larger case does not establish a speed improvement. These timings cover in-memory text processing in Node.js on this Windows machine; file reads, database queries, Zotero UI work, and full-library search were not timed. Search reuses Zotero's existing text cache and page statistics without invoking PDF extraction.

## Limits

Zotero 9+ is the manifest installation range. Only Zotero 10.0.5 on Windows was executed for this release. macOS/Linux, future Zotero versions, other-plugin combinations, cloud sync, external PDF applications, and actual paste into Explorer/PowerPoint were not tested. File opening delegates to Zotero; WebDAV downloads were not exercised. Reading a full-text cache still creates a full input string; intermediate match maps are chunked.

The [CI workflow](../.github/workflows/ci.yml) runs Node/Python checks and packaging on Windows and Ubuntu. Its live result is visible on the repository's Actions page; it does not run desktop Zotero. Reproducibility was verified by repeated local builds; identical compressed bytes across different Python/zlib environments are not promised.

See [test instructions](../tests/README.md) and the [security review](SECURITY_REVIEW.md).
