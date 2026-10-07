# Changelog

## 1.0.0 — 2026-10-04

- Search metadata and existing PDF text from Zotero's native quick-search field, with highlighted surrounding context.
- Display matching physical PDF pages as `PDF p. 3` or `PDF pp. 3–4` using Zotero's existing extracted-text cache. Click a page label to open the native PDF reader at the first matching page.
- Show **PDF text / PDF 본문** when page mapping is unavailable or cache statistics disagree. No PDF reparsing or reindexing is added.
- Provide complete Korean and English interfaces for search, favorites, citation settings, menus, and messages. The language follows Zotero's application setting at startup, with English for other languages. Bibliographic metadata and CSL language remain unchanged.
- Open attachments from search-result titles, preferring the PDF containing the displayed match. Preserve the query when returning from the reader; records without files open in the native list.
- Select references near the top of the native list with **Show in Library / 서지목록에서 보기**, within Zotero's normal scroll bounds. Preserve the sort, collection, and tag filters.
- Rank complete phrases before partial matches; sort by newest or oldest bibliographic date added.
- Display title, authors, year, and journal in Zotero's center pane. Long text wraps within the pane without changing sidebar widths.
- Add a native favorites column backed by the existing `★` tag.
- Configure short citations and choose native CSL or expanded custom long citations.
- Copy accessible original attachments, including multiple files on Windows.
- Fix wrapped-title overlap and disclosure-arrow clicks changing favorites.
- Use fictional articles, authors, journals, and a placeholder DOI in public screenshots and citation previews.
- Harden large-text processing, malformed-note handling, isolated test shutdown, and release packaging.
- Include the license in the XPI, SHA-256 checksums, and update metadata.

The current package, completed checks, and runtime coverage are documented in [VERIFICATION.md](docs/VERIFICATION.md).
