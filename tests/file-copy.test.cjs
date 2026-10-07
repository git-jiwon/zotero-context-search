const test = require("node:test");
const assert = require("node:assert/strict");
const FileCopy = require("../addon/content/file-copy.js");

function fixture({ isWin = true, locale = 'ko-KR' } = {}) {
  const items = new Map();
  const writes = [];
  const transferred = [];
  const fileObjects = new Map();
  const nativeTransfers = [];
  const Zotero = {
    locale,
    isWin,
    Items: { getAsync: async id => Array.isArray(id) ? id.map(key => items.get(key)) : items.get(id) },
    File: { pathToFile: path => fileObjects.get(path) },
    Promise: { delay: async () => {} },
  };
  const Services = { clipboard: { kGlobalClipboard: 1, setData: (...args) => nativeTransfers.push(args) } };
  const Components = {
    interfaces: { nsITransferable: "nsITransferable" },
    classes: { "@mozilla.org/widget/transferable;1": { createInstance: type => {
      assert.equal(type, "nsITransferable");
      const transfer = { init: context => transferred.push(["init", context]),
        addDataFlavor: flavor => transferred.push(["flavor", flavor]),
        setTransferData: (...args) => transferred.push(["data", ...args]) };
      return transfer;
    } } },
  };
  const copier = new FileCopy({ Zotero, Services, Components });
  copier._writeFiles = async files => writes.push(files);
  function attachment(path, extra = {}) {
    const file = path && {
      path, leafName: path.split(/[\\/]/).pop(), exists: () => true, isFile: () => true,
      equals: other => isWin ? path.toLowerCase() === other.path.toLowerCase() : path === other.path,
    };
    if (file) fileObjects.set(path, file);
    const item = {
      id: items.size + 1, isRegularItem: () => false, isFileAttachment: () => true,
      isPDFAttachment: () => /\.pdf$/i.test(path || ""), getFilePathAsync: async () => path,
      getField: () => file?.leafName || "Missing attachment", ...extra,
    };
    items.set(item.id, item);
    return item;
  }
  function parent(attachments, extra = {}) {
    const item = {
      id: items.size + 1, isRegularItem: () => true, isFileAttachment: () => false,
      numAttachments: () => attachments.length, getBestAttachments: async () => attachments,
      getField: () => "Parent paper", ...extra,
    };
    items.set(item.id, item);
    return item;
  }
  function note() {
    return parent([], { isRegularItem: () => false, isNote: () => true, getField: () => "Note" });
  }
  return { copier, Zotero, Services, Components, writes, transferred, nativeTransfers, attachment, parent, note, fileObjects };
}

test("parent chooses the first local original in Zotero's PDF-prioritized attachment order", async () => {
  const f = fixture();
  const missingPDF = f.attachment(false);
  const pdf = f.attachment("C:\\Library\\paper.pdf");
  const html = f.attachment("C:\\Library\\snapshot.html");
  const parent = f.parent([missingPDF, pdf, html]);
  const result = await f.copier.copy([parent.id]);
  assert.equal(result.count, 1);
  assert.equal(result.files[0].attachmentID, pdf.id);
  assert.equal(f.writes[0][0].path, "C:\\Library\\paper.pdf");
});

test("a directly selected attachment keeps its exact file even if its parent has a different PDF", async () => {
  const f = fixture();
  const pdf = f.attachment("C:\\Library\\paper.pdf");
  const supplement = f.attachment("C:\\Library\\supplement.xlsx");
  const parent = f.parent([pdf, supplement]);
  supplement.parentItemID = parent.id;
  const result = await f.copier.copy(supplement.id);
  assert.equal(result.files[0].attachmentID, supplement.id);
  assert.equal(f.writes[0][0].leafName, "supplement.xlsx");
});

test("multiple parents and attachments deduplicate actual files and preserve selected order", async () => {
  const f = fixture();
  const first = f.attachment("C:\\Library\\first.pdf");
  const second = f.attachment("C:\\Library\\second.pdf");
  const alias = f.attachment("c:\\library\\FIRST.pdf");
  const parent = f.parent([first]);
  const result = await f.copier.copy([second.id, parent.id, first.id, alias.id, second.id]);
  assert.equal(result.copiedCount, 2);
  assert.deepEqual(f.writes[0].map(file => file.leafName), ["second.pdf", "first.pdf"]);
});

test("missing directly selected attachment never substitutes its parent's other file", async () => {
  const f = fixture();
  const pdf = f.attachment("C:\\Library\\paper.pdf");
  const missing = f.attachment(false);
  missing.parentItemID = f.parent([pdf, missing]).id;
  await assert.rejects(f.copier.copy([missing.id]), error => error.code === "NO_LOCAL_FILES" && error.skipped[0].reason === "missing");
  assert.equal(f.writes.length, 0);
});

test("empty, note, web-link, deleted and missing selections leave clipboard untouched", async () => {
  const f = fixture();
  const link = f.attachment(false, { isFileAttachment: () => false });
  const deleted = f.attachment("C:\\Library\\deleted.pdf", { deleted: true });
  const note = f.note();
  for (const selection of [[], [note], [link], [deleted], [999]]) {
    await assert.rejects(f.copier.copy(selection), /로컬 원본 파일이 없습니다/);
  }
  assert.equal(f.writes.length, 0);
});

test("partial availability copies local files once and returns actionable skipped details", async () => {
  const f = fixture();
  const local = f.attachment("C:\\Library\\local.pdf");
  const missing = f.attachment(false);
  const result = await f.copier.copy([local.id, missing.id, f.note().id]);
  assert.equal(result.count, 1);
  assert.deepEqual(result.skipped.map(item => item.reason), ["missing", "ineligible"]);
  assert.match(result.skipped[0].message, /내려받거나/);
  assert.equal(f.writes.length, 1);
});

test("directory paths are never copied and a parent's next actual file can be used", async () => {
  const f = fixture();
  const directory = f.attachment("C:\\Library\\folder");
  f.fileObjects.get("C:\\Library\\folder").isFile = () => false;
  const local = f.attachment("C:\\Library\\paper.pdf");
  const result = await f.copier.copy(f.parent([directory, local]));
  assert.equal(result.files[0].attachmentID, local.id);
});

test("older attachment-order fallback still prefers a local PDF", async () => {
  const f = fixture();
  const html = f.attachment("C:\\Library\\snapshot.html");
  const pdf = f.attachment("C:\\Library\\paper.pdf");
  const parent = f.parent([html, pdf], { getBestAttachments: undefined, getAttachments: () => [html.id, pdf.id] });
  assert.equal((await f.copier.copy(parent)).files[0].attachmentID, pdf.id);
});

test("menu eligibility excludes notes, links, deleted entries and parents without attachments", () => {
  const f = fixture();
  const pdf = f.attachment("C:\\Library\\paper.pdf");
  assert.equal(f.copier.canCopy([pdf]), true);
  assert.equal(f.copier.canCopy([f.parent([pdf])]), true);
  assert.equal(f.copier.canCopy([f.note(), f.parent([])]), false);
  assert.equal(f.copier.canCopy([f.attachment(false, { isFileAttachment: () => false })]), false);
  assert.equal(f.copier.canCopy([f.attachment("C:\\Deleted.pdf", { deleted: true })]), false);
});

test("single-file clipboard sends an nsIFile payload, never a string path", async () => {
  const f = fixture();
  delete f.copier._writeFiles;
  const item = f.attachment("C:\\Library\\연구 원본.pdf");
  await f.copier.copy(item);
  const data = f.transferred.find(row => row[0] === "data");
  assert.equal(data[1], "application/x-moz-file");
  assert.equal(data[2], f.fileObjects.get("C:\\Library\\연구 원본.pdf"));
  assert.equal(f.nativeTransfers.length, 1);
  assert.equal(f.nativeTransfers[0][2], 1);
});

test("non-Windows multi-file copy reports the limitation before touching clipboard", async () => {
  const f = fixture({ isWin: false });
  delete f.copier._writeFiles;
  const one = f.attachment("/home/user/one.pdf"), two = f.attachment("/home/user/two.pdf");
  await assert.rejects(f.copier.copy([one, two]), /하나씩 선택/);
  assert.equal(f.nativeTransfers.length, 0);
  assert.equal(f.transferred.length, 0);
});

test("Windows DROPFILES layout contains UTF-16 paths, a fixed 20-byte header and double NUL", () => {
  const paths = ["C:\\Papers\\한글 😀.pdf", "\\\\server\\share\\paper.pdf"];
  const data = FileCopy.makeDropFiles(paths);
  const view = new DataView(data.buffer);
  assert.equal(view.getUint32(0, true), 20);
  assert.equal(view.getUint32(4, true), 0);
  assert.equal(view.getUint32(8, true), 0);
  assert.equal(view.getUint32(12, true), 0);
  assert.equal(view.getUint32(16, true), 1);
  assert.equal(Buffer.from(data.slice(20)).toString("utf16le"), paths.join("\0") + "\0\0");
});

test("Windows payload rejects empty, relative or NUL-injected paths", () => {
  for (const paths of [[], ["paper.pdf"], ["https://example.org/file.pdf"], ["C:\\one.pdf\0C:\\two.pdf"]]) {
    assert.throws(() => FileCopy.makeDropFiles(paths), /file path/);
  }
});

function nativeFixture(overrides = {}, options = {}) {
  const f = fixture(options);
  const events = [];
  let next = 0;
  const api = {
    allocate: bytes => { const handle = ++next; events.push(["allocate", handle, [...bytes]]); return handle; },
    copyFormat: () => 49301,
    open: () => { events.push(["open"]); return true; },
    empty: () => { events.push(["empty"]); return true; },
    set: (format, handle) => { events.push(["set", format, handle]); return true; },
    close: () => events.push(["close"]),
    free: handle => events.push(["free", handle]),
    dispose: () => events.push(["dispose"]),
    ...overrides,
  };
  f.copier._openWindowsAPI = () => api;
  const write = () => f.copier._writeWindowsFiles([{ path: "C:\\one.pdf" }, { path: "C:\\two.pdf" }]);
  return { ...f, events, api, write };
}

test("Windows native boundary prepares data before clearing and transfers both memory blocks to OS", async () => {
  const f = nativeFixture();
  await f.write();
  assert.deepEqual(f.events.map(row => row[0]), ["allocate", "allocate", "open", "empty", "set", "set", "close", "dispose"]);
  assert.deepEqual(f.events.filter(row => row[0] === "set"), [["set", 15, 1], ["set", 49301, 2]]);
  assert.deepEqual(f.events[1][2], [1, 0, 0, 0]); // Copy, not move.
});

test("busy clipboard preserves contents and frees every prepared allocation", async () => {
  const f = nativeFixture({ open: () => false });
  await assert.rejects(f.write(), /클립보드를 사용 중/);
  assert.equal(f.events.some(row => row[0] === "empty"), false);
  assert.equal(f.events.some(row => row[0] === "close"), false);
  assert.deepEqual(f.events.filter(row => row[0] === "free"), [["free", 1], ["free", 2]]);
  assert.equal(f.events.at(-1)[0], "dispose");
});

test("failed main clipboard write closes clipboard and frees memory still owned by plugin", async () => {
  const f = nativeFixture({ set: () => false });
  await assert.rejects(f.write(), /클립보드에 넣지 못/);
  assert.deepEqual(f.events.slice(-4), [["close"], ["free", 1], ["free", 2], ["dispose"]]);
});

test("allocation failure preserves clipboard and frees the previous allocation", async () => {
  const f = nativeFixture();
  let calls = 0;
  f.api.allocate = () => { if (++calls === 2) throw new Error("Allocation failed"); return 1; };
  await assert.rejects(f.write(), /Allocation failed/);
  assert.deepEqual(f.events, [["free", 1], ["dispose"]]);
});

test("optional effect failure retains successful file copy and frees only untransferred memory", async () => {
  const f = nativeFixture({ set: format => format === 15 });
  await f.write();
  assert.deepEqual(f.events.filter(row => row[0] === "free"), [["free", 2]]);
});

test("an unavailable Zotero owner window aborts before clearing the clipboard", async () => {
  const f = nativeFixture({ open: () => { throw new Error("Zotero 창을 활성화한 뒤 다시 복사해 주세요."); } });
  await assert.rejects(f.write(), /창을 활성화/);
  assert.equal(f.events.some(row => row[0] === "empty"), false);
  assert.deepEqual(f.events.filter(row => row[0] === "free"), [["free", 1], ["free", 2]]);
});

test("English file-copy summaries and skipped reasons preserve file names and counts", async () => {
  const f = fixture({ locale: 'en-US' });
  const available = f.attachment('C:\\Library\\한글 원본.pdf');
  const missing = f.attachment(false);
  const result = await f.copier.copy([available, missing, f.note(), 999]);
  assert.equal(result.count, 1);
  assert.equal(result.files[0].name, '한글 원본.pdf');
  assert.match(result.message, /Original files copied: 1\./);
  assert.match(result.message, /Items skipped.*: 3\./);
  assert.deepEqual(result.skipped.map(entry => entry.reason), ['missing', 'ineligible', 'unavailable']);
  assert.match(result.skipped[0].message, /Open the attachment to download it/);
  assert.match(result.skipped[1].message, /Notes and web links/);
  assert.match(result.skipped[2].message, /could not be read/);
  assert.doesNotMatch([result.message, ...result.skipped.map(entry => entry.message)].join(' '), /[가-힣]/);
  await assert.rejects(f.copier.copy([missing]), error => error.code === 'NO_LOCAL_FILES' && /No local original files/.test(error.message));
  assert.throws(() => FileCopy.makeDropFiles(['relative.pdf'], f.copier.l10n), /valid local file path/);
});

test("English native clipboard failures keep memory cleanup and non-Windows guidance", async () => {
  for (const [overrides, message] of [
    [{ open: () => false }, /Another application is using the clipboard/],
    [{ empty: () => false }, /clipboard could not be prepared/],
    [{ set: () => false }, /could not be copied to the clipboard/],
  ]) {
    const f = nativeFixture(overrides, { locale: 'en-US' });
    await assert.rejects(f.write(), message);
    assert.deepEqual(f.events.filter(row => row[0] === 'free'), [['free', 1], ['free', 2]]);
    assert.equal(f.events.at(-1)[0], 'dispose');
  }
  const f = fixture({ locale: 'en-US', isWin: false });
  await assert.rejects(FileCopy.prototype._writeFiles.call(f.copier, [{}, {}]), /select one file at a time/);
});

test("Win32 callback errors use the captured English locale without opening the OS clipboard", () => {
  for (const [failure, message] of [
    ['GlobalAlloc', /Memory could not be allocated/],
    ['GlobalLock', /Memory for file copying could not be accessed/],
    ['GetActiveWindow', /Activate the Zotero window/],
  ]) {
    const f = fixture({ locale: 'en-US' });
    const closed = [];
    const ctypes = {
      jschar: { ptr: {} },
      open(name) {
        return {
          declare(symbol) { return () => ({ isNull: () => symbol === failure }); },
          close() { closed.push(name); },
        };
      },
    };
    f.copier.chromeUtils = { importESModule: () => ({ ctypes }) };
    const api = f.copier._openWindowsAPI();
    try {
      assert.throws(() => failure === 'GetActiveWindow' ? api.open() : api.allocate(new Uint8Array(4)), message);
    }
    finally { api.dispose(); }
    assert.deepEqual(closed, ['kernel32.dll', 'user32.dll']);
  }
});
