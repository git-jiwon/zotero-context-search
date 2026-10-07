const test = require("node:test");
const assert = require("node:assert/strict");
const Citation = require("../addon/content/citation.js");

test("malformed repeated formatting tags remain literal without quadratic scanning", { timeout: 2000 }, () => {
  const citation = new Citation({ Zotero: { locale: 'ko-KR' } });
  const malformed = "<span ".repeat(100000);
  assert.equal(citation._text(malformed), malformed.trim());
  assert.equal(citation._text('<span class="test">Title</span>'), "Title");
});

function fixture({ locale = 'ko-KR' } = {}) {
  const copied = [];
  const items = new Map();
  const Zotero = {
    locale,
    CreatorTypes: { getID: name => name === "author" ? 1 : 3 },
    Items: { getAsync: async id => items.get(id) },
    Utilities: { Internal: { copyTextToClipboard: text => copied.push(text) } },
  };
  const citation = new Citation({ Zotero });
  const author = (firstName, lastName, extra = {}) => ({ firstName, lastName, creatorTypeID: 1, ...extra });
  function item(fields = {}, creators = [author("John", "Chen")], extra = {}) {
    const data = {
      title: "An energy study", journalAbbreviation: "Nat. Energy", publicationTitle: "Nature Energy",
      volume: "1", date: "2016-09-26", DOI: "10.1038/nenergy.2016.138", ...fields,
    };
    const entry = {
      id: items.size + 1,
      getField: name => data[name] || "",
      getCreators: () => creators,
      isRegularItem: () => true,
      ...extra,
    };
    items.set(entry.id, entry);
    return entry;
  }
  return { citation, item, author, copied, Zotero };
}

test("matches the user's numbered slide citation, including volume and DOI", () => {
  const { citation, item, author } = fixture();
  const entry = item({}, [author("John", "Chen"), author("Ana", "Lee")]);
  assert.equal(citation.format(entry), "[1] J. Chen et al., Nat. Energy 1 (2016). https://doi.org/10.1038/nenergy.2016.138");
});

test("single author is not labelled et al. and custom per-call index is supported", () => {
  const { citation, item } = fixture();
  assert.equal(citation.format(item(), { index: 4 }), "[4] J. Chen, Nat. Energy 1 (2016). https://doi.org/10.1038/nenergy.2016.138");
});

test("uses the full stored journal name when no abbreviation exists", () => {
  const { citation, item } = fixture();
  assert.equal(citation.format(item({ journalAbbreviation: "", DOI: "" })), "[1] J. Chen, Nature Energy 1 (2016).");
});

test("missing volume and DOI are omitted, missing author uses the stored title", () => {
  const { citation, item } = fixture();
  assert.equal(citation.format(item({ volume: "", DOI: "" }, [])), "[1] An energy study, Nat. Energy (2016).");
  assert.equal(citation.format(item({ journalAbbreviation: "", publicationTitle: "", volume: "", DOI: "", date: "" })), "[1] J. Chen (n.d.).");
});

test("Korean and Chinese names are preserved, corporate authors are not initialled", () => {
  const { citation, item, author } = fixture();
  assert.match(citation.format(item({}, [author("민수", "김")])), /^\[1\] 김민수,/);
  assert.match(citation.format(item({}, [author("明", "王")])), /^\[1\] 王明,/);
  assert.match(citation.format(item({}, [author("", "World Health Organization", { fieldMode: 1 })])), /^\[1\] World Health Organization,/);
});

test("editors are not mistaken for authors and an editor does not trigger et al.", () => {
  const { citation, item, author } = fixture();
  const editor = author("Ada", "Editor", { creatorTypeID: 3 });
  assert.match(citation.format(item({}, [editor, author("John", "Chen")])), /^\[1\] J\. Chen,/);
  assert.match(citation.format(item({}, [editor])), /^\[1\] An energy study,/);
});

test("normalizes DOI prefixes without adding punctuation or truncating valid suffixes", () => {
  const { citation, item } = fixture();
  for (const DOI of ["doi:10.1038/nenergy.2016.138", "https://doi.org/10.1038/nenergy.2016.138", "http://dx.doi.org/10.1038/nenergy.2016.138"]) {
    assert.match(citation.format(item({ DOI })), /https:\/\/doi\.org\/10\.1038\/nenergy\.2016\.138$/);
  }
  assert.match(citation.format(item({ DOI: "10.1000/example(1)." })), /https:\/\/doi\.org\/10\.1000\/example\(1\)\.$/);
  assert.doesNotMatch(citation.format(item({ DOI: "not a DOI" })), /doi\.org/);
});

test("copy uses selected order, one plain-text line each, and resets numbering each time", async () => {
  const { citation, item, author, copied } = fixture();
  const first = item();
  const second = item({}, [author("Ana", "Lee")]);
  const text = await citation.copy([second.id, first.id]);
  const lines = text.split("\n");
  assert.match(lines[0], /^\[1\] A\. Lee,/);
  assert.match(lines[1], /^\[2\] J\. Chen,/);
  assert.deepEqual(copied, [text]);
  await citation.copy([first.id]);
  assert.match(copied[1], /^\[1\] J\. Chen,/);
});

test("empty or ineligible selections leave the clipboard untouched", async () => {
  const { citation, item, copied } = fixture();
  const attachment = item({}, [], { isRegularItem: () => false });
  await assert.rejects(citation.copy([]), /선택/);
  await assert.rejects(citation.copy([999, attachment.id]), /선택/);
  assert.deepEqual(copied, []);
});

test("selected attachment and note cite their parent once, preserving the first selected order", async () => {
  const { citation, item, author } = fixture();
  const first = item();
  const second = item({}, [author("Ana", "Lee")]);
  const attachment = item({}, [], { isRegularItem: () => false, parentItemID: second.id });
  const note = item({}, [], { isRegularItem: () => false, parentItemID: second.id });
  const text = await citation.copy([attachment.id, first.id, second.id, note.id, first.id]);
  const lines = text.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[1\] A\. Lee,/);
  assert.match(lines[1], /^\[2\] J\. Chen,/);
});

test("loads lazy parent item data and creators before citation formatting", async () => {
  const { citation, item } = fixture();
  const loaded = new Set();
  const parent = item({}, [], {
    async loadDataType(type) { loaded.add(type); },
    getField(name) {
      assert.equal(loaded.has("itemData"), true);
      return name === "date" ? "2016" : "";
    },
    getCreators() {
      assert.equal(loaded.has("creators"), true);
      return [{ creatorTypeID: 1, firstName: "John", lastName: "Chen" }];
    },
  });
  const attachment = item({}, [], { isRegularItem: () => false, parentItemID: parent.id });
  assert.equal(await citation.copy([attachment.id, parent.id]), "[1] J. Chen (2016).");
  assert.deepEqual([...loaded], ["itemData", "creators"]);
});

test("unsupported journal fields and false metadata values do not leak into a book citation", () => {
  const { citation, item } = fixture();
  const book = item({}, [], {
    getField(name) {
      if (name === "journalAbbreviation" || name === "publicationTitle") throw new Error("Unsupported field");
      if (name === "title") return "A research handbook";
      if (name === "date") return "2024";
      return false;
    },
  });
  assert.equal(citation.format(book), "[1] A research handbook (2024).");
});

test("rich title metadata becomes one plain-text citation line", () => {
  const { citation, item } = fixture();
  const entry = item({ title: "An <i>energy</i>\nstudy &amp; analysis", DOI: "" }, []);
  assert.equal(citation.format(entry), "[1] An energy study & analysis, Nat. Energy 1 (2016).");
});

test("short citation options change fields, author length and numbering without editing metadata", async () => {
  const { citation, item, author } = fixture();
  citation.preferences = { getOptions: () => ({ number: false, title: true, authors: "all", journalStyle: "full", volume: false, year: false, doi: false }) };
  const paper = item({}, [author("John", "Chen"), author("Ana", "Lee")]);
  assert.equal(await citation.copy([paper.id]), "J. Chen, A. Lee, An energy study, Nature Energy.");
  assert.equal(paper.getField("journalAbbreviation"), "Nat. Energy");
});

test("custom long citation inherits short settings but always includes every author and title", async () => {
  const { citation, item, author } = fixture();
  citation.preferences = { getOptions: () => ({ mode: "custom", startNumber: 7, title: false, authors: "first", doi: false }) };
  const first = item({}, [author("John", "Chen"), author("Ana", "Lee")]);
  const second = item({}, [author("Bo", "Park")]);
  const lines = (await citation.copy([first.id, second.id], { style: "long" })).split("\n");
  assert.equal(lines[0], "[7] J. Chen, A. Lee, An energy study, Nat. Energy 1 (2016).");
  assert.match(lines[1], /^\[8\] B\. Park, An energy study,/);
  assert.doesNotMatch(lines.join(" "), /et al|doi.org/);
});

test("omitting the year does not duplicate punctuation after et al or journal abbreviations", () => {
  const { citation, item, author } = fixture();
  const paper = item({ journalAbbreviation: "J. Test." }, [author("John", "Chen"), author("Ana", "Lee")]);
  assert.equal(citation.format(paper, { options: { journal: false, volume: false, year: false, doi: false } }), "[1] J. Chen et al.");
  assert.equal(citation.format(paper, { options: { volume: false, year: false, doi: false } }), "[1] J. Chen et al., J. Test.");
});

test("native long citation passes selected CSL style, locale and HTML mode to Zotero", async () => {
  const { citation, item, copied, Zotero } = fixture();
  const paper = item();
  const calls = [];
  Zotero.Prefs = { get: name => name === "export.quickCopy.setting" ? "saved-format" : "ko-KR" };
  Zotero.QuickCopy = { unserializeSetting: raw => { assert.equal(raw, "saved-format"); return { mode: "bibliography", id: "csl-style", locale: "en-US", contentType: "html" }; } };
  Zotero.Styles = { init: async () => {}, get: id => id === "csl-style" ? { title: "My saved style" } : null };
  Zotero.getMainWindow = () => ({ Zotero_File_Interface: { copyItemsToClipboard: (...args) => calls.push(args) } });
  const result = await citation.copy([paper.id], { style: "long" });
  assert.deepEqual(calls, [[[paper], "csl-style", "en-US", true, false]]);
  assert.equal(result.style, "My saved style");
  assert.equal(copied.length, 0);
  Zotero.QuickCopy.unserializeSetting = () => ({ mode: "export", id: "bibtex" });
  await assert.rejects(citation.copy([paper.id], { style: "long" }), /빠른 복사/);
  assert.equal(calls.length, 1);
});

test("English citation errors and fallback titles leave stored bibliography unchanged", async () => {
  const { citation, item, author, copied } = fixture({ locale: 'en-US' });
  await assert.rejects(citation.copy([]), /Select a reference to cite/);
  assert.throws(() => citation.format(null), /No reference is available/);
  assert.throws(() => citation.format(item(), { index: 0 }), /integer of 1 or greater/);
  assert.throws(() => citation.format(item(), { style: 'invalid' }), /Unsupported citation format: invalid/);
  assert.throws(() => citation.format(item(), { style: 'long' }), /Use long citation copy/);
  const blank = item({ title: '' }, []);
  assert.equal(citation.format(blank, { options: { journal: false, volume: false, year: false, doi: false } }), '[1] Untitled.');
  const paper = item({ title: '저장된 제목', journalAbbreviation: '가상 저널', DOI: '' }, [author('민수', '김')]);
  await citation.copy([paper.id], { options: { title: true } });
  assert.equal(copied.at(-1), '[1] 김민수, 저장된 제목, 가상 저널 1 (2016).');
});

test("English native citation guidance preserves the CSL locale and style identity", async () => {
  const { citation, item, Zotero } = fixture({ locale: 'en-US' });
  const paper = item();
  Zotero.Prefs = { get: () => 'ko-KR' };
  Zotero.Styles = { init: async () => {}, get: () => null };
  Zotero.QuickCopy = { unserializeSetting: () => ({ mode: 'export', id: 'bibtex' }) };
  await assert.rejects(citation.copy([paper.id], { style: 'long' }), /Settings → Export → Quick Copy/);
  Zotero.QuickCopy.unserializeSetting = () => ({ mode: 'bibliography', id: 'native-style', locale: 'ko-KR' });
  await assert.rejects(citation.copy([paper.id], { style: 'long' }), /style selected for Zotero Quick Copy is unavailable/);
  Zotero.Styles.get = () => ({ title: '한국어 인용 스타일' });
  Zotero.getMainWindow = () => null;
  await assert.rejects(citation.copy([paper.id], { style: 'long' }), /Open Zotero's main window/);
  const calls = [];
  Zotero.getMainWindow = () => ({ Zotero_File_Interface: { copyItemsToClipboard: (...args) => calls.push(args) } });
  const result = await citation.copy([paper.id], { style: 'long' });
  assert.equal(result.style, '한국어 인용 스타일');
  assert.equal(calls[0][2], 'ko-KR');
});
