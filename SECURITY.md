# Security policy

## Supported releases

Security fixes target the current published release. Include the version and, when available, the package's SHA-256 checksum in a report.

The add-on allows installation on Zotero 9 and newer. Runtime testing has used Zotero 10.0.5 on Windows; installation eligibility does not establish compatibility with every older or future version, or with other operating systems.

## Report a vulnerability

If private vulnerability reporting is enabled, use [GitHub's private report form](https://github.com/git-jiwon/zotero-context-search/security/advisories/new).

If that form is unavailable, contact the [maintainer](https://github.com/git-jiwon) to arrange a private channel before sharing technical details. You may open an issue requesting a private contact method, without including the vulnerability or an exploit.

Include the add-on version, Zotero version, operating system, expected behavior, actual behavior, and minimal reproduction steps. Prefer synthetic library items and files. Do not include private papers, account credentials, synchronization credentials, or personal library data.

## Security boundary

This is a privileged Zotero desktop add-on. It can use Zotero's database, filesystem, and native clipboard APIs; it does not run in a Chrome-style browser-extension sandbox.

- Search uses the existing Zotero index and available text caches. Library text is inserted into the search UI as text nodes, rather than executed as HTML or JavaScript.
- PDF page links use page locations derived from the existing text cache and open Zotero's native reader. Unknown or inconsistent page mappings are not guessed.
- Citation and file copying run when the user chooses a copy command. The add-on writes the clipboard and does not read its previous contents.
- File access resolves existing attachments of selected items. Linked files may reside outside Zotero storage, including network shares.
- Windows multi-file copying uses the bundled ctypes module and Windows system APIs. It does not start a shell or helper executable.

See [Privacy](docs/PRIVACY.md) for data handling and network behavior. Code review and automated tests reduce known risks but do not guarantee security. Tests replace clipboard output with test functions; they do not validate every destination application's paste behavior.
