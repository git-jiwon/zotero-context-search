const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Preferences = require("../addon/content/preferences.js");

test("stored citation choices survive a new preferences instance and long custom inherits them", () => {
  const values = new Map();
  const Zotero = { locale: "ko-KR", Prefs: { get: key => values.get(key), set: (key, value) => values.set(key, value) } };
  const preferences = new Preferences({ Zotero });
  preferences.setOption("startNumber", 7);
  preferences.setOption("doi", false);
  preferences.setOption("journalStyle", "full");
  preferences.setOption("mode", "custom", "long");
  const restored = new Preferences({ Zotero });
  assert.equal(restored.getOptions("short").startNumber, 7);
  assert.equal(restored.getOptions("short").title, false);
  assert.deepEqual(restored.getOptions("long"), {
    ...restored.getOptions("short"), title: true, authors: "all", mode: "custom",
  });
  assert.equal(restored.getOptions("long").doi, false);
  assert.equal(restored.getOptions("long").journalStyle, "full");
  for (const number of [0, -1, 1.2, NaN]) assert.throws(() => restored.setOption("startNumber", number));
  assert.equal(restored.getOptions("short").startNumber, 7);
});

// Parse this pane's real static fragment into a small DOM. Replacing a parent's
// text removes its children here too, so localization cannot silently lose inputs.
function paneDocument() {
  function node(tag, attributes = {}) {
    return {
      tag, attributes, children: [], dataset: Object.fromEntries(Object.entries(attributes)
        .filter(([name]) => name.startsWith("data-"))
        .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value])),
      listeners: new Map(), type: attributes.type, value: attributes.value || "", checked: false,
      get textContent() { return this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); },
      set textContent(value) { this.children = [String(value)]; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(callback);
      },
      removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); },
      dispatch(name) { for (const callback of this.listeners.get(name) || []) callback(); },
    };
  }
  const root = node("document");
  const stack = [root];
  const source = fs.readFileSync(path.join(__dirname, "../addon/content/preferences.xhtml"), "utf8");
  for (const token of source.matchAll(/<(\/?)([\w:-]+)([^>]*)>|([^<]+)/gu)) {
    if (token[4] !== undefined) { stack.at(-1).children.push(token[4]); continue; }
    if (token[1]) { stack.pop(); continue; }
    const attributes = Object.fromEntries([...token[3].matchAll(/([\w:-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    const child = node(token[2], attributes);
    stack.at(-1).children.push(child);
    if (!token[3].trimEnd().endsWith("/")) stack.push(child);
  }
  const all = parent => [parent, ...parent.children.filter(child => typeof child !== "string").flatMap(all)];
  root.getElementById = id => all(root).find(child => child.attributes.id === id);
  root.querySelectorAll = selector => {
    const name = /^\[([^\]]+)\]$/.exec(selector)?.[1];
    assert.ok(name, `Unsupported test selector: ${selector}`);
    return all(root).filter(child => Object.hasOwn(child.attributes, name));
  };
  root.defaultView = node("window");
  return root;
}

function fixture(locale = "en-US") {
  const values = new Map([["export.quickCopy.setting", "bibliography=style-id"]]);
  const registrations = [], unregistered = [], formats = [], opened = [];
  const Zotero = {
    locale,
    Prefs: { get: key => values.get(key), set: (key, value) => values.set(key, value) },
    PreferencePanes: { register: async options => { registrations.push(options); return "pane-id"; }, unregister: id => unregistered.push(id) },
    QuickCopy: { unserializeSetting: () => ({ mode: "bibliography", id: "style-id", locale: "de-DE" }) },
    Styles: { init: async () => {}, get: () => ({ title: "CSL style title" }) },
    Utilities: { Internal: { openPreferences: id => opened.push(id) } },
    ContextSearchPlugin: { citation: { format: (item, options) => {
      formats.push({ item, options }); return "Unchanged citation content";
    } } },
  };
  return { Zotero, values, registrations, unregistered, formats, opened, doc: paneDocument(), preferences: new Preferences({ Zotero }) };
}

for (const [locale, expected] of [
  ["ko-KR", {
    pane: "Context Search · 인용 설정", short: "짧은 인용", first: "첫 저자 + et al.",
    aria: "짧은 인용에 포함할 정보", saved: "변경한 설정을 이 PC에 저장했습니다.",
    invalid: "시작 번호는 1 이상의 정수로 입력해 주세요.", reset: "기본 인용 설정으로 되돌렸습니다.",
    native: "현재 형식: CSL style title",
  }],
  ["en-US", {
    pane: "Context Search · Citation settings", short: "Short citations", first: "First author + et al.",
    aria: "Fields included in short citations", saved: "Changes saved on this computer.",
    invalid: "Enter a whole starting number of at least 1.", reset: "Default citation settings restored.",
    native: "Current format: CSL style title",
  }],
]) {
  test(`${locale} preferences mount preserves controls, saves choices and resets defaults`, async () => {
    const { preferences, Zotero, doc, registrations, unregistered, formats, opened, values } = fixture(locale);
    const controls = doc.querySelectorAll("[data-zcs-citation-option]");
    assert.equal(controls.length, 10);
    await preferences.init();
    preferences.mount(doc);
    await Promise.resolve();
    assert.equal(registrations[0].label, expected.pane);
    assert.deepEqual(doc.querySelectorAll("[data-zcs-citation-option]"), controls);
    const label = key => doc.querySelectorAll("[data-zcs-i18n]").find(node => node.dataset.zcsI18n === key);
    assert.equal(label("shortTitle").textContent, expected.short);
    assert.equal(label("firstAuthor").textContent, expected.first);
    assert.equal(doc.querySelectorAll("[data-zcs-i18n-aria-label]")[0].getAttribute("aria-label"), expected.aria);
    assert.equal(doc.getElementById("zcs-citation-native-style").textContent, expected.native);
    assert.equal(doc.getElementById("zcs-citation-short-preview").textContent, "Unchanged citation content");
    if (locale === "en-US") assert.doesNotMatch(doc.textContent, /[가-힣]/u);

    preferences.mount(doc);
    assert.ok(controls.every(control => control.listeners.get("change").size === 1));
    const title = controls.find(control => control.dataset.zcsCitationOption === "title");
    title.checked = true; title.dispatch("change");
    assert.equal(preferences.getOptions().title, true);
    assert.equal(doc.getElementById("zcs-citation-save-status").textContent, expected.saved);

    const start = doc.getElementById("zcs-citation-start-number");
    start.value = "0"; start.dispatch("input");
    assert.equal(start.getAttribute("aria-invalid"), "true");
    assert.equal(doc.getElementById("zcs-citation-save-status").textContent, expected.invalid);
    assert.equal(preferences.getOptions().startNumber, 1);
    start.value = "7"; start.dispatch("input");
    assert.equal(start.getAttribute("aria-invalid"), null);
    assert.equal(preferences.getOptions().startNumber, 7);
    const mode = doc.getElementById("zcs-citation-long-mode");
    mode.value = "custom"; mode.dispatch("change");
    assert.equal(doc.getElementById("zcs-citation-long-custom").hidden, false);
    assert.equal(doc.getElementById("zcs-citation-long-native").hidden, true);
    assert.equal(formats.at(-1).options.style, "long");
    assert.equal(formats.at(-1).options.options.authors, "all");
    assert.equal(formats.at(-1).item.getField("title"), "Example research article");
    assert.equal(values.get("export.quickCopy.setting"), "bibliography=style-id");
    assert.equal(Zotero.QuickCopy.unserializeSetting().locale, "de-DE");

    doc.getElementById("zcs-citation-open-export").dispatch("click");
    assert.deepEqual(opened, ["zotero-prefpane-export"]);
    doc.getElementById("zcs-citation-reset").dispatch("click");
    assert.equal(preferences.getOptions().title, false);
    assert.equal(preferences.getOptions().startNumber, 1);
    assert.equal(preferences.getOptions("long").mode, "zotero");
    assert.equal(doc.getElementById("zcs-citation-save-status").textContent, expected.reset);
    assert.equal(doc.getElementById("zcs-citation-long-native").hidden, false);
    preferences.destroy();
    assert.deepEqual(unregistered, ["pane-id"]);
    assert.equal(preferences.panes.size, 0);
    assert.ok(controls.every(control => control.listeners.get("change").size === 0));
  });
}

test("English native-style notices and preview failures are localized without changing citation locale", async () => {
  for (const [prepare, expected] of [
    [Zotero => { Zotero.QuickCopy.unserializeSetting = () => ({ mode: "export" }); }, "Quick Copy is not set to a bibliography style. Choose a citation style using the button below."],
    [Zotero => { Zotero.Styles.get = () => null; }, "The selected citation style is not installed. Check your citation styles in Zotero."],
    [Zotero => { Zotero.Styles.init = async () => { throw new Error("Unavailable"); }; }, "Choose a default Quick Copy citation style in Zotero Settings → Export."],
  ]) {
    const { Zotero, preferences, doc } = fixture();
    prepare(Zotero);
    preferences.mount(doc);
    await Promise.resolve();
    assert.equal(doc.getElementById("zcs-citation-native-style").textContent, expected);
    preferences.destroy();
  }
  const { Zotero, preferences, doc } = fixture();
  delete Zotero.ContextSearchPlugin.citation;
  preferences.mount(doc);
  assert.equal(doc.getElementById("zcs-citation-short-preview").textContent, "The example could not be loaded. Restart the plugin.");
  Zotero.ContextSearchPlugin.citation = { format() { throw new Error("Example formatting failed."); } };
  preferences.refresh(doc);
  assert.equal(doc.getElementById("zcs-citation-short-preview").textContent, "Preview error: Example formatting failed.");
  assert.throws(() => preferences.getOptions("invalid"), /Unsupported citation settings/);
  assert.throws(() => preferences.setOption("mode", "invalid", "long"), /Choose a long citation format/);
  assert.throws(() => preferences.setOption("journalStyle", "invalid"), /Invalid citation settings/);
  preferences.destroy();
});
