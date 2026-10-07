"use strict";

// This deliberately uses stored metadata instead of guessing journal abbreviations.
var ZCSCitation = class ZCSCitation {
  constructor({ Zotero, preferences, l10n }) {
    this.Zotero = Zotero;
    this.preferences = preferences;
    this.l10n = l10n || (typeof ZCSL10n !== "undefined" ? ZCSL10n : require("./localization.js")).create({ Zotero });
  }

  _options(style, overrides = {}) {
    if (!["short", "long"].includes(style)) throw new Error(this.l10n.t("지원하지 않는 인용 형식: {style}", "Unsupported citation format: {style}", { style }));
    return {
      number: true, startNumber: 1, authors: "first", title: false,
      journal: true, journalStyle: "abbreviated", volume: true, year: true, doi: true,
      mode: style === "long" ? "zotero" : "custom",
      ...this.preferences?.getOptions(style), ...overrides,
      ...(style === "long" ? { authors: "all", title: true } : {}),
    };
  }

  format(item, { style = "short", index, options = {} } = {}) {
    const settings = this._options(style, options);
    if (style === "long" && settings.mode === "zotero") throw new Error(this.l10n.t("Zotero 양식은 긴 인용 복사에서 생성합니다.", "Use long citation copy to generate a citation in Zotero's style."));
    index = index ?? settings.startNumber;
    if (!item || typeof item.getField !== "function") throw new Error(this.l10n.t("인용할 문헌이 없습니다.", "No reference is available to cite."));
    if (!Number.isInteger(index) || index < 1) throw new Error(this.l10n.t("인용 번호는 1 이상의 정수여야 합니다.", "The citation number must be an integer of 1 or greater."));
    const field = name => {
      try { return this._text(item.getField(name)); }
      catch (error) {
        // Item types such as books may not expose journal-specific fields.
        if (error.name === "UnloadedDataException") throw error;
        return "";
      }
    };
    const creators = item.getCreators?.() || [];
    const authorID = this.Zotero.CreatorTypes?.getID?.("author") ?? 1;
    const authors = creators.filter(creator =>
      (creator.creatorTypeID === authorID || creator.creatorType === "author")
      && (this._text(creator.lastName) || this._text(creator.firstName) || this._text(creator.name))
    );
    const author = authors.length
      ? settings.authors === "all" ? authors.map(creator => this._author(creator)).join(", ")
        : this._author(authors[0]) + (authors.length > 1 ? " et al." : "")
      : field("title") || this.l10n.t("제목 없음", "Untitled");
    const journal = settings.journal ? settings.journalStyle === "full"
      ? field("publicationTitle") || field("journalAbbreviation")
      : field("journalAbbreviation") || field("publicationTitle") : "";
    const volume = settings.volume ? field("volume") : "";
    const publication = [journal, volume].filter(Boolean).join(" ");
    const date = field("date");
    const year = date.match(/(?:^|\D)(\d{4})(?!\d)/)?.[1] || "n.d.";
    const title = settings.title && authors.length ? field("title") : "";
    let body = [author, title, publication].filter(Boolean).join(", ")
      + (settings.year ? ` (${year})` : "");
    if (!/[.!?。！？]$/u.test(body)) body += ".";
    const doi = settings.doi ? this._doi(field("DOI")) : "";
    return `${settings.number ? `[${index}] ` : ""}${body}${doi ? ` https://doi.org/${doi}` : ""}`;
  }

  async _items(itemIDs) {
    const selected = Array.isArray(itemIDs) ? itemIDs : [itemIDs];
    const items = [];
    const cited = new Set();
    for (const id of selected) {
      if (!id) continue;
      let item = typeof id === "object" ? id : await this.Zotero.Items.getAsync(id);
      const parents = new Set();
      while (item && typeof item.isRegularItem === "function" && !item.isRegularItem() && item.parentItemID) {
        if (parents.has(item.parentItemID)) { item = null; break; }
        parents.add(item.parentItemID);
        item = await this.Zotero.Items.getAsync(item.parentItemID);
      }
      if (!item || (typeof item.isRegularItem === "function" && !item.isRegularItem())) continue;
      const key = item.id ?? item;
      if (cited.has(key)) continue;
      if (typeof item.loadDataType === "function") {
        await item.loadDataType("itemData");
        await item.loadDataType("creators");
      }
      items.push(item);
      cited.add(key);
    }
    if (!items.length) throw new Error(this.l10n.t("인용할 문헌을 선택해 주세요.", "Select a reference to cite."));
    return items;
  }

  async copy(itemIDs, { style = "short", options = {} } = {}) {
    const settings = this._options(style, options);
    const items = await this._items(itemIDs);
    if (style === "long" && settings.mode === "zotero") return this._copyNative(items);
    const text = items.map((item, index) => this.format(item, {
      style, options: settings, index: settings.startNumber + index,
    })).join("\n");
    this.Zotero.Utilities.Internal.copyTextToClipboard(text);
    return text;
  }

  async _copyNative(items) {
    await this.Zotero.Styles.init();
    const format = this.Zotero.QuickCopy.unserializeSetting(this.Zotero.Prefs.get("export.quickCopy.setting"));
    if (format?.mode !== "bibliography" || !format.id) {
      throw new Error(this.l10n.t("Zotero 설정 → 내보내기 → 빠른 복사에서 인용 스타일을 선택해 주세요. 현재 설정은 BibTeX 같은 데이터 내보내기 형식입니다.", "Choose a citation style in Zotero Settings → Export → Quick Copy. The current setting is a data export format such as BibTeX."));
    }
    const style = this.Zotero.Styles.get(format.id);
    if (!style) throw new Error(this.l10n.t("Zotero 빠른 복사에 지정된 인용 스타일을 찾을 수 없습니다. Zotero 설정에서 설치된 스타일을 선택해 주세요.", "The style selected for Zotero Quick Copy is unavailable. Choose an installed style in Zotero Settings."));
    const copy = this.Zotero.getMainWindow()?.Zotero_File_Interface;
    if (!copy?.copyItemsToClipboard) throw new Error(this.l10n.t("Zotero 기본 창을 연 뒤 다시 복사해 주세요.", "Open Zotero's main window, then try copying again."));
    const locale = format.locale || this.Zotero.Prefs.get("export.quickCopy.locale");
    // Use Zotero's own rich-text/plain-text clipboard path and CSL engine.
    // Numbering, ordering and included fields belong to the selected CSL style.
    copy.copyItemsToClipboard(items, format.id, locale, format.contentType === "html", false);
    return { mode: "zotero", count: items.length, style: style.title || format.id };
  }

  _author(creator) {
    const last = this._text(creator.lastName || creator.name);
    const first = this._text(creator.firstName);
    if (creator.fieldMode === 1) return last || first;
    if (!first) return last;
    if (!last) return first;
    // Preserve names written in Korean, Chinese or Japanese instead of initialising them.
    const eastAsian = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u;
    if (eastAsian.test(first) || eastAsian.test(last)) {
      return eastAsian.test(first) && eastAsian.test(last) ? last + first : `${first} ${last}`;
    }
    const initial = first.match(/\p{L}/u)?.[0];
    return initial ? `${initial.toLocaleUpperCase()}. ${last}` : `${first} ${last}`;
  }

  _doi(value) {
    const doi = value.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i, "").trim();
    // Validate the DOI shape and preserve suffix punctuation; never add a period to its URL.
    return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi : "";
  }

  _text(value) {
    return String(value === false || value == null ? "" : value)
      .replace(/<\/?(?:i|b|em|strong|sub|sup|span|sc)(?:\s[^<>]*)?>/gi, "")
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => ({
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
      })[entity.toLowerCase()])
      .replace(/\s+/g, " ").trim();
  }
};

if (typeof module !== "undefined") module.exports = ZCSCitation;
