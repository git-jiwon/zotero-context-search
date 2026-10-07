"use strict";

// Resolve only files already on disk. This module never downloads, exports,
// renames, moves or changes an attachment, and never reads the clipboard.
var ZCSFileCopy = class ZCSFileCopy {
  constructor({ Zotero, Services, Components: components, ChromeUtils: chromeUtils, l10n }) {
    this.Zotero = Zotero;
    this.Services = Services;
    this.l10n = l10n || (typeof ZCSL10n !== "undefined" ? ZCSL10n : require("./localization.js")).create({ Zotero, Services });
    this.components = components || (typeof Components !== "undefined" ? Components : null);
    this.chromeUtils = chromeUtils || (typeof ChromeUtils !== "undefined" ? ChromeUtils : null);
  }

  canCopy(items) {
    return (Array.isArray(items) ? items : [items]).some(item => {
      if (!item || item.deleted) return false;
      if (item.isFileAttachment?.()) return true;
      if (!item.isRegularItem?.()) return false;
      try { return typeof item.numAttachments !== "function" || item.numAttachments() > 0; }
      catch (_) { return true; } // Child metadata may not be loaded until the command runs.
    });
  }

  async copy(itemIDs) {
    const selected = Array.isArray(itemIDs) ? itemIDs : [itemIDs];
    const files = [];
    const copied = [];
    const skipped = [];
    const visited = new Set();
    for (const id of selected) {
      if (!id) continue;
      let item;
      try { item = typeof id === "object" ? id : await this.Zotero.Items.getAsync(id); }
      catch (_) { skipped.push(this._skip(null, "unavailable", id)); continue; }
      if (!item || item.deleted) {
        skipped.push(this._skip(item, "unavailable", id));
        continue;
      }
      const key = item.id || item;
      if (visited.has(key)) continue;
      visited.add(key);
      if (!item.isRegularItem?.() && !item.isFileAttachment?.()) {
        skipped.push(this._skip(item, "ineligible"));
        continue;
      }
      try {
        const resolved = await this._resolve(item);
        if (!resolved) {
          skipped.push(this._skip(item, "missing"));
          continue;
        }
        const duplicate = files.some(file => {
          try { return file.equals(resolved.file); }
          catch (_) { return file.path === resolved.file.path; }
        });
        if (duplicate) continue;
        files.push(resolved.file);
        copied.push({ itemID: item.id, attachmentID: resolved.attachment.id, name: resolved.file.leafName });
      }
      catch (_) { skipped.push(this._skip(item, "unavailable")); }
    }
    if (!files.length) {
      const error = new Error(this.l10n.t("복사할 로컬 원본 파일이 없습니다. 첨부파일을 한 번 열어 내려받거나 파일 연결을 확인해 주세요.", "No local original files are available to copy. Open the attachment to download it, or check its file link."));
      error.code = "NO_LOCAL_FILES";
      error.skipped = skipped;
      throw error;
    }
    // All resolution and validation happens before replacing clipboard contents.
    await this._writeFiles(files);
    return {
      count: files.length,
      copiedCount: files.length,
      files: copied,
      skipped,
      message: this.l10n.t("{count}개 원본 파일을 복사했습니다.", "Original files copied: {count}.", { count: files.length })
        + (skipped.length ? " " + this.l10n.t("{count}개 항목은 로컬 파일이 없거나 복사 대상이 아니어서 제외했습니다.", "Items skipped because no local file was available or the item could not be copied: {count}.", { count: skipped.length }) : ""),
    };
  }

  async _resolve(item) {
    let attachments;
    if (item.isFileAttachment?.()) attachments = [item];
    else {
      await item.loadDataType?.("childItems");
      await item.loadDataType?.("itemData"); // getBestAttachments compares the parent URL.
      if (typeof item.getBestAttachments === "function") attachments = await item.getBestAttachments();
      else {
        attachments = await this.Zotero.Items.getAsync(item.getAttachments?.() || []);
        // Stable sort retains Zotero's attachment order within each type.
        attachments.sort((a, b) => Number(!!b.isPDFAttachment?.()) - Number(!!a.isPDFAttachment?.()));
      }
    }
    for (const attachment of attachments || []) {
      if (!attachment || attachment.deleted || !attachment.isFileAttachment?.()) continue;
      try {
        const path = await attachment.getFilePathAsync();
        if (!path) continue;
        const file = this.Zotero.File.pathToFile(path);
        if (!file.exists() || !file.isFile()) continue;
        return { attachment, file };
      }
      catch (_) { /* Try the next local attachment for a parent item. */ }
    }
    return null;
  }

  _skip(item, reason, fallbackID) {
    let title = "";
    try { title = item?.getField?.("title") || ""; } catch (_) {}
    const messages = {
      ineligible: this.l10n.t("노트와 웹 링크는 원본 파일 복사 대상이 아닙니다.", "Notes and web links cannot be copied as original files."),
      missing: this.l10n.t("로컬 파일이 없습니다. 첨부파일을 열어 내려받거나 파일 연결을 확인해 주세요.", "The local file is unavailable. Open the attachment to download it, or check its file link."),
      unavailable: this.l10n.t("항목이나 파일을 읽을 수 없습니다.", "The item or file could not be read."),
    };
    return { itemID: item?.id || (typeof fallbackID === "number" ? fallbackID : null), title, reason, message: messages[reason] };
  }

  async _writeFiles(files) {
    if (files.length === 1) {
      // Gecko converts an nsIFile payload into the native file clipboard format
      // (CF_HDROP on Windows). Passing a path as text would not copy the file.
      const { classes: Cc, interfaces: Ci } = this.components;
      const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      transferable.init(null);
      transferable.addDataFlavor("application/x-moz-file");
      transferable.setTransferData("application/x-moz-file", files[0]);
      const clipboard = this.Services.clipboard;
      clipboard.setData(transferable, null, clipboard.kGlobalClipboard);
      return;
    }
    if (!this.Zotero.isWin) {
      throw new Error(this.l10n.t("여러 원본 파일을 한 번에 복사하는 기능은 Windows에서 지원합니다. 이 환경에서는 파일을 하나씩 선택해 주세요.", "Copying multiple original files at once is supported on Windows. On this system, select one file at a time."));
    }
    await this._writeWindowsFiles(files);
  }

  // Pure serialization, also exercised by tests without touching the clipboard.
  // DROPFILES is 20 bytes on both Win32 and Win64, followed by UTF-16LE paths
  // separated by NUL and terminated by an additional NUL.
  // https://learn.microsoft.com/windows/win32/api/shlobj_core/ns-shlobj_core-dropfiles
  static makeDropFiles(paths, l10n) {
    if (!paths.length || paths.some(path => typeof path !== "string" || path.includes("\0")
      || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/.test(path))) {
      throw new Error(l10n ? l10n.t("유효한 로컬 파일 경로가 필요합니다.", "A valid local file path is required.") : "A valid local file path is required.");
    }
    const names = paths.join("\0") + "\0\0";
    const bytes = new Uint8Array(20 + names.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 20, true);
    view.setUint32(16, 1, true);
    for (let i = 0; i < names.length; i++) view.setUint16(20 + i * 2, names.charCodeAt(i), true);
    return bytes;
  }

  async _writeWindowsFiles(files) {
    const data = ZCSFileCopy.makeDropFiles(files.map(file => file.path), this.l10n);
    const api = this._openWindowsAPI();
    let dropHandle = null;
    let effectHandle = null;
    let opened = false;
    try {
      // Allocate and fill both blocks before opening/clearing the clipboard.
      dropHandle = api.allocate(data);
      effectHandle = api.allocate(new Uint8Array([1, 0, 0, 0])); // DROPEFFECT_COPY, never MOVE.
      const effectFormat = api.copyFormat();
      for (let attempt = 0; attempt < 4; attempt++) {
        opened = api.open();
        if (opened) break;
        if (attempt < 3 && this.Zotero.Promise?.delay) await this.Zotero.Promise.delay(30);
      }
      if (!opened) throw new Error(this.l10n.t("다른 프로그램이 클립보드를 사용 중입니다. 잠시 후 다시 복사해 주세요.", "Another application is using the clipboard. Wait a moment, then try copying again."));
      if (!api.empty()) throw new Error(this.l10n.t("클립보드를 준비하지 못했습니다. 다시 시도해 주세요.", "The clipboard could not be prepared. Try again."));
      if (!api.set(15, dropHandle)) throw new Error(this.l10n.t("원본 파일을 클립보드에 넣지 못했습니다. 다시 시도해 주세요.", "The original files could not be copied to the clipboard. Try again."));
      // Ownership transfers to Windows only after SetClipboardData succeeds.
      dropHandle = null;
      if (effectFormat && api.set(effectFormat, effectHandle)) effectHandle = null;
      // Preferred DropEffect is advisory. CF_HDROP remains a valid copy even if
      // this optional format fails; no cut/move format is ever published.
    }
    finally {
      if (opened) api.close();
      if (dropHandle) api.free(dropHandle);
      if (effectHandle) api.free(effectHandle);
      api.dispose();
    }
  }

  _openWindowsAPI() {
    // Gecko accepts one nsIFile per transferable. A narrow Win32 boundary is
    // needed for a single CF_HDROP containing multiple files. It uses Zotero's
    // bundled ctypes module and system DLLs, without a shell or helper process.
    const { ctypes } = this.chromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    const l10n = this.l10n;
    const libraries = [];
    try {
      const user = ctypes.open("user32.dll"); libraries.push(user);
      const kernel = ctypes.open("kernel32.dll"); libraries.push(kernel);
      const abi = ctypes.winapi_abi;
      const ptr = ctypes.voidptr_t;
      const uint = ctypes.uint32_t;
      const bool = ctypes.int32_t;
      const declare = (library, name, result, ...args) => library.declare(name, abi, result, ...args);
      const activeWindow = declare(user, "GetActiveWindow", ptr);
      const open = declare(user, "OpenClipboard", bool, ptr);
      const empty = declare(user, "EmptyClipboard", bool);
      const close = declare(user, "CloseClipboard", bool);
      const set = declare(user, "SetClipboardData", ptr, uint, ptr);
      const register = declare(user, "RegisterClipboardFormatW", uint, ctypes.jschar.ptr);
      const alloc = declare(kernel, "GlobalAlloc", ptr, uint, ctypes.size_t);
      const lock = declare(kernel, "GlobalLock", ptr, ptr);
      const unlock = declare(kernel, "GlobalUnlock", bool, ptr);
      const free = declare(kernel, "GlobalFree", ptr, ptr);
      return {
        allocate(bytes) {
          const handle = alloc(0x42, bytes.length); // GMEM_MOVEABLE | GMEM_ZEROINIT
          if (handle.isNull()) throw new Error(l10n.t("파일 복사용 메모리를 준비하지 못했습니다.", "Memory could not be allocated for file copying."));
          const address = lock(handle);
          if (address.isNull()) { free(handle); throw new Error(l10n.t("파일 복사용 메모리에 접근하지 못했습니다.", "Memory for file copying could not be accessed.")); }
          try {
            const buffer = ctypes.cast(address, ctypes.uint8_t.array(bytes.length).ptr).contents;
            for (let i = 0; i < bytes.length; i++) buffer[i] = bytes[i];
          }
          catch (error) { unlock(handle); free(handle); throw error; }
          unlock(handle);
          return handle;
        },
        copyFormat: () => register("Preferred DropEffect"),
        open() {
          // GetActiveWindow returns a window belonging to the calling UI thread.
          // Never use NULL: EmptyClipboard would then leave no valid owner.
          const owner = activeWindow();
          if (owner.isNull()) throw new Error(l10n.t("Zotero 창을 활성화한 뒤 다시 복사해 주세요.", "Activate the Zotero window, then try copying again."));
          return !!open(owner);
        },
        empty: () => !!empty(),
        set: (format, handle) => !set(format, handle).isNull(),
        close: () => close(),
        free: handle => free(handle),
        dispose: () => { for (const library of libraries.reverse()) library.close(); },
      };
    }
    catch (error) {
      for (const library of libraries.reverse()) library.close();
      throw error;
    }
  }
};

if (typeof module !== "undefined") module.exports = ZCSFileCopy;
