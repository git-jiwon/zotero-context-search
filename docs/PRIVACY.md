# Privacy

Zotero Context Search processes library data within Zotero. It does not use AI services, embeddings, analytics, telemetry, or a separate search server.

## Library data and settings

Search queries use Zotero's existing search facilities. The add-on reads bibliographic metadata, tags, notes, and available extracted PDF text to display matching passages. It uses page boundaries in that cache and Zotero's indexing statistics to label matching physical PDF pages. It does not reparse PDFs, reindex, create a separate persistent text index, or run OCR. In-memory caches are discarded when the add-on stops. Displayed library content is inserted as text, not interpreted as executable HTML.

Favorites are stored as the existing `★` tag and follow Zotero's normal data synchronization. Citation settings and result-sort preferences are stored on each PC and are not synchronized by this add-on. Its interface is for desktop Zotero; it does not extend Zotero's web or mobile interface.

## Clipboard and files

Choosing a citation or original-file copy command replaces the clipboard with the requested output. The add-on does not read the previous clipboard contents. Original-file copying uses the operating system's file-copy format, which includes file paths so the destination application can copy the originals. Other applications and operating-system clipboard features handle that output under their own policies.

The add-on resolves attachments belonging to selected items. It does not download missing attachments for copying, or move, delete, or rewrite original files. Linked attachments can be outside the Zotero storage folder. UNC paths and mapped network drives may cause the operating system to access a network share while checking or reading a file.

## Network activity

- Zotero's add-on update checks and release downloads contact [GitHub](https://github.com/git-jiwon/zotero-context-search). Library contents and search queries are not included in the add-on's update metadata.
- Zotero's existing account synchronization and file synchronization continue according to its settings. Opening a result or clicking a PDF page label delegates to Zotero's attachment or reader APIs and may download the attachment through Zotero Storage or configured WebDAV storage.
- Network shares may be accessed by the operating system as described above.

These boundaries do not imply that Zotero or the operating system makes no network connections. The add-on's review and tests are limited checks, not a guarantee of security or privacy. See the [security policy](../SECURITY.md) for reporting concerns.
