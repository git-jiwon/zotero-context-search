"use strict";

// These settings belong to this computer. Favorite tags continue to use Zotero sync.
var ZCSCitationPreferences = class ZCSCitationPreferences {
  constructor({ Zotero, Services, l10n, rootURI = "", id = "context-search@local.zotero" }) {
    this.Zotero = Zotero;
    this.Services = Services;
    this.l10n = l10n || (typeof ZCSL10n !== "undefined" ? ZCSL10n : require("./localization.js")).create({ Zotero, Services });
    this.rootURI = rootURI;
    this.id = id;
    this.paneID = null;
    this.panes = new Map();
    this.prefix = "contextSearch.citation.";
    this.defaults = Object.freeze({
      number: true, startNumber: 1, authors: "first", title: false,
      journal: true, journalStyle: "abbreviated", volume: true, year: true, doi: true,
    });
  }

  async init() {
    if (this.paneID) return;
    this.paneID = await this.Zotero.PreferencePanes.register({
      pluginID: this.id,
      id: "zcs-citation-preferences",
      label: this.l10n.t("Context Search · 인용 설정", "Context Search · Citation settings"),
      image: this.rootURI + "icons/icon-48.png",
      src: this.rootURI + "content/preferences.xhtml",
      stylesheets: [this.rootURI + "content/preferences.css"],
    });
  }

  getOptions(style = "short") {
    if (!["short", "long"].includes(style)) throw new Error(this.l10n.t("지원하지 않는 인용 설정입니다.", "Unsupported citation settings."));
    const options = {};
    for (const [name, fallback] of Object.entries(this.defaults)) {
      let value;
      try { value = this.Zotero.Prefs.get(this.prefix + "short." + name); }
      catch (_) { /* Missing or invalid user preferences use the defaults. */ }
      options[name] = this._valid(name, value) ? value : fallback;
    }
    options.mode = "custom";
    if (style === "long") {
      let mode;
      try { mode = this.Zotero.Prefs.get(this.prefix + "long.mode"); }
      catch (_) { /* Native Zotero formatting is the initial long format. */ }
      options.mode = mode === "custom" ? "custom" : "zotero";
      options.authors = "all";
      options.title = true;
    }
    return options;
  }

  setOption(name, value, style = "short") {
    if (style === "long" && name === "mode") {
      if (!["zotero", "custom"].includes(value)) throw new Error(this.l10n.t("긴 인용 형식을 선택해 주세요.", "Choose a long citation format."));
    }
    else if (style !== "short" || !Object.hasOwn(this.defaults, name) || !this._valid(name, value)) {
      throw new Error(name === "startNumber"
        ? this.l10n.t("시작 번호는 1 이상의 정수로 입력해 주세요.", "Enter a whole starting number of at least 1.")
        : this.l10n.t("유효하지 않은 인용 설정입니다.", "Invalid citation settings."));
    }
    this.Zotero.Prefs.set(this.prefix + style + "." + name, value);
  }

  _valid(name, value) {
    if (name === "startNumber") return Number.isInteger(value) && value >= 1 && value <= 2147483647;
    if (name === "authors") return ["first", "all"].includes(value);
    if (name === "journalStyle") return ["abbreviated", "full"].includes(value);
    return Object.hasOwn(this.defaults, name) && typeof value === "boolean";
  }

  _localize(doc) {
    const labels = {
      shortTitle: ["짧은 인용", "Short citations"],
      shortDescription: ["PPT에 붙여 넣을 인용에 필요한 정보를 선택하세요. 변경 사항은 바로 저장됩니다.", "Choose the information to include in citations for your slides. Changes save immediately."],
      shortFields: ["짧은 인용에 포함할 정보", "Fields included in short citations"],
      number: ["번호 [1]", "Number [1]"],
      title: ["논문 제목", "Article title"],
      journal: ["저널명", "Journal"],
      volume: ["권", "Volume"],
      year: ["연도", "Year"],
      doi: ["DOI 링크", "DOI link"],
      authors: ["저자 표시", "Authors"],
      firstAuthor: ["첫 저자 + et al.", "First author + et al."],
      allAuthors: ["모든 저자", "All authors"],
      journalStyle: ["저널명 표시", "Journal name"],
      abbreviatedJournal: ["저장된 약칭 (없으면 전체 이름)", "Stored abbreviation (full name if unavailable)"],
      fullJournal: ["전체 이름", "Full name"],
      startNumber: ["시작 번호", "Starting number"],
      numberHelp: ["한 번에 여러 문헌을 복사하면 시작 번호부터 차례로 번호를 붙입니다.", "When copying several references, numbering begins at the starting number and continues in order."],
      preview: ["미리보기", "Preview"],
      exampleDescription: ["가상 문헌으로 양식을 미리 보여줍니다. 실제 복사에는 선택한 문헌의 서지정보가 사용됩니다.", "The preview uses a fictional reference. Copied citations use the metadata of your selected references."],
      longTitle: ["긴 인용", "Long citations"],
      format: ["사용할 양식", "Format"],
      nativeMode: ["Zotero의 빠른 복사 인용 스타일", "Zotero Quick Copy citation style"],
      customMode: ["짧은 인용 설정 + 모든 저자와 논문 제목", "Short citation settings + all authors and article title"],
      nativeDescription: ["저자, 제목, 번호, 구두점 등은 Zotero에서 선택한 스타일을 따릅니다. 위의 짧은 인용 설정은 적용하지 않습니다.", "Authors, titles, numbering, and punctuation follow the style selected in Zotero. The short citation settings above do not apply."],
      openExport: ["Zotero 빠른 복사 설정 열기", "Open Zotero Quick Copy settings"],
      customDescription: ["위의 짧은 인용 설정을 유지하면서 모든 저자와 논문 제목을 항상 포함합니다.", "Use the short citation settings above and always include all authors and the article title."],
      localSettings: ["인용 설정은 이 PC에 저장됩니다.", "Citation settings are saved on this computer."],
      reset: ["인용 설정을 기본값으로 되돌리기", "Restore default citation settings"],
    };
    for (const node of doc.querySelectorAll("[data-zcs-i18n]")) {
      const text = labels[node.dataset.zcsI18n];
      if (text) node.textContent = this.l10n.t(...text);
    }
    for (const node of doc.querySelectorAll("[data-zcs-i18n-aria-label]")) {
      const text = labels[node.dataset.zcsI18nAriaLabel];
      if (text) node.setAttribute("aria-label", this.l10n.t(...text));
    }
  }

  mount(doc) {
    if (!doc?.getElementById("zcs-citation-short")) return;
    if (this.panes.has(doc)) {
      this.refresh(doc);
      return;
    }
    this._localize(doc);
    const cleanup = [];
    const listen = (node, event, callback) => {
      if (!node) return;
      node.addEventListener(event, callback);
      cleanup.push(() => node.removeEventListener(event, callback));
    };
    this.panes.set(doc, { cleanup, previewVersion: 0 });
    for (const node of doc.querySelectorAll("[data-zcs-citation-option]")) {
      const update = () => {
        const name = node.dataset.zcsCitationOption;
        const style = node.dataset.zcsCitationStyle || "short";
        let value = node.type === "checkbox" ? node.checked : node.value;
        if (name === "startNumber") value = Number(value);
        try {
          this.setOption(name, value, style);
          node.removeAttribute("aria-invalid");
          doc.getElementById("zcs-citation-save-status").textContent = this.l10n.t("변경한 설정을 이 PC에 저장했습니다.", "Changes saved on this computer.");
          this._render(doc);
        }
        catch (error) {
          node.setAttribute("aria-invalid", "true");
          doc.getElementById("zcs-citation-save-status").textContent = error.message;
        }
      };
      listen(node, "change", update);
      if (node.type === "number") listen(node, "input", update);
    }
    listen(doc.getElementById("zcs-citation-reset"), "click", () => {
      for (const [name, value] of Object.entries(this.defaults)) this.setOption(name, value);
      this.setOption("mode", "zotero", "long");
      this.refresh(doc);
      doc.getElementById("zcs-citation-save-status").textContent = this.l10n.t("기본 인용 설정으로 되돌렸습니다.", "Default citation settings restored.");
    });
    listen(doc.getElementById("zcs-citation-open-export"), "click", () => {
      this.Zotero.Utilities.Internal.openPreferences("zotero-prefpane-export");
    });
    listen(doc.getElementById("zcs-citation-short"), "showing", () => this.refresh(doc));
    listen(doc.defaultView, "unload", () => this._unmount(doc));
    this.refresh(doc);
  }

  refresh(doc) {
    const short = this.getOptions("short");
    const long = this.getOptions("long");
    for (const node of doc.querySelectorAll("[data-zcs-citation-option]")) {
      const options = node.dataset.zcsCitationStyle === "long" ? long : short;
      const value = options[node.dataset.zcsCitationOption];
      if (node.type === "checkbox") node.checked = value;
      else node.value = String(value);
      node.removeAttribute("aria-invalid");
    }
    this._render(doc);
  }

  _render(doc) {
    const state = this.panes.get(doc);
    if (!state) return;
    const version = ++state.previewVersion;
    const short = this.getOptions("short");
    const long = this.getOptions("long");
    doc.getElementById("zcs-citation-start-number").disabled = !short.number;
    doc.getElementById("zcs-citation-journal-style").disabled = !short.journal;
    doc.getElementById("zcs-citation-long-custom").hidden = long.mode !== "custom";
    doc.getElementById("zcs-citation-long-native").hidden = long.mode !== "zotero";
    const citation = this.Zotero.ContextSearchPlugin?.citation;
    const example = this._exampleItem();
    for (const style of ["short", "long"]) {
      const options = style === "short" ? short : long;
      if (options.mode === "zotero") continue;
      const target = doc.getElementById(`zcs-citation-${style}-preview`);
      try {
        target.textContent = citation
          ? citation.format(example, { style, index: options.startNumber, options })
          : this.l10n.t("예시를 불러올 수 없습니다. 플러그인을 다시 켜 주세요.", "The example could not be loaded. Restart the plugin.");
      }
      catch (error) {
        target.textContent = this.l10n.t("미리보기 오류: {error}", "Preview error: {error}", { error: error.message });
      }
    }
    if (long.mode === "zotero") this._nativeStyle(doc, state, version);
  }

  async _nativeStyle(doc, state, version) {
    const target = doc.getElementById("zcs-citation-native-style");
    target.textContent = this.l10n.t("Zotero의 빠른 복사 형식을 확인하는 중…", "Checking Zotero's Quick Copy format…");
    try {
      const raw = this.Zotero.Prefs.get("export.quickCopy.setting");
      const setting = this.Zotero.QuickCopy.unserializeSetting(raw);
      if (!setting || setting.mode !== "bibliography") {
        target.textContent = this.l10n.t("빠른 복사 형식이 서지 인용 스타일로 설정되어 있지 않습니다. 아래 버튼에서 인용 스타일을 선택해 주세요.", "Quick Copy is not set to a bibliography style. Choose a citation style using the button below.");
        return;
      }
      await this.Zotero.Styles.init();
      if (this.panes.get(doc) !== state || state.previewVersion !== version) return;
      const style = this.Zotero.Styles.get(setting.id);
      target.textContent = style
        ? this.l10n.t("현재 형식: {title}", "Current format: {title}", { title: style.title })
        : this.l10n.t("선택한 인용 스타일이 설치되어 있지 않습니다. Zotero에서 인용 스타일을 확인해 주세요.", "The selected citation style is not installed. Check your citation styles in Zotero.");
    }
    catch (_) {
      if (this.panes.get(doc) !== state || state.previewVersion !== version) return;
      target.textContent = this.l10n.t("Zotero 설정 → 내보내기에서 빠른 복사의 기본 인용 스타일을 선택해 주세요.", "Choose a default Quick Copy citation style in Zotero Settings → Export.");
    }
  }

  _exampleItem() {
    const fields = {
      title: "Example research article",
      journalAbbreviation: "Fict. J.", publicationTitle: "Fictional Journal",
      volume: "1", date: "2024", DOI: "10.0000/example-article",
    };
    const authorID = this.Zotero.CreatorTypes?.getID?.("author") ?? 1;
    return {
      getField: name => fields[name] || "",
      getCreators: () => [
        { firstName: "Sample", lastName: "Author", creatorTypeID: authorID },
        { firstName: "Demo", lastName: "Writer", creatorTypeID: authorID },
      ],
    };
  }

  _unmount(doc) {
    const state = this.panes.get(doc);
    if (!state) return;
    this.panes.delete(doc);
    for (const remove of state.cleanup) remove();
  }

  destroy() {
    for (const doc of this.panes.keys()) this._unmount(doc);
    if (this.paneID) this.Zotero.PreferencePanes.unregister(this.paneID);
    this.paneID = null;
  }
};

if (typeof module !== "undefined") module.exports = ZCSCitationPreferences;
