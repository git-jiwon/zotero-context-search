/* Inline result view for Zotero's existing item list area. */
var ZCSInlineUI = class ZCSInlineUI {
  constructor({ Zotero, controller, win }) {
    this.Zotero = Zotero;
    this.controller = controller;
    this.l10n = controller.l10n || (typeof ZCSL10n !== "undefined" ? ZCSL10n : require("./localization.js")).create({ Zotero });
    this.win = win;
    this.doc = win.document;
    this.host = null;
    this.tree = null;
    this.style = null;
    this.rows = new Map();
    this.originalTree = null;
    this.disposed = false;
  }

  t(ko, en, args) { return this.l10n.t(ko, en, args); }

  number(value) { return Number(value).toLocaleString(this.l10n.locale); }

  element(tag, className, text) {
    const element = this.doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  addToWindow() {
    if (this.disposed || this.host) return;
    const pane = this.doc.getElementById("zotero-items-pane");
    this.tree = this.doc.getElementById("zotero-items-tree");
    if (!pane || !this.tree) return;
    this.originalTree = {
      hidden: !!this.tree.hidden,
      display: this.tree.style.getPropertyValue("display"),
      displayPriority: this.tree.style.getPropertyPriority("display"),
    };
    this.style = this.doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    this.style.id = "zcs-inline-style";
    this.style.textContent = `
      #zcs-inline-results {
        display: flex; flex: 1; min-width: 0; min-height: 0; overflow: auto;
        /* Native panes use an automatic flex basis. Keep result text out of
           their intrinsic width calculation, preserving the user's splitters. */
        contain: inline-size; overflow-wrap: anywhere;
        flex-direction: column; background: #fff;
        color: #202733; font: 14px/1.5 system-ui, sans-serif;
      }
      #zcs-inline-results[hidden] { display: none !important; }
      #zcs-inline-results .zcs-inline-head {
        display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; flex: 0 0 auto;
        box-sizing: border-box; min-height: 40px; padding: 6px 12px;
        border-bottom: 1px solid #e5eaf0; background: #fafbfd;
        color: #667085; font-size: 11px;
      }
      #zcs-inline-results .zcs-inline-head strong { color: #344054; font-size: 12px; font-weight: 600; white-space: nowrap; }
      #zcs-inline-results .zcs-inline-count { white-space: nowrap; }
      #zcs-inline-results .zcs-inline-sort { display: flex; gap: 4px; align-items: center; }
      #zcs-inline-results .zcs-inline-sort-button {
        appearance: none; width: auto; min-width: 0; height: auto; min-height: 24px; max-height: none;
        margin: 0; padding: 2px 6px; border: 1px solid transparent; border-radius: 4px;
        background: transparent; color: #667085; font: 11px/18px system-ui, sans-serif;
        white-space: nowrap; cursor: pointer;
      }
      #zcs-inline-results .zcs-inline-sort-button:hover { background: #eef3fa; }
      #zcs-inline-results .zcs-inline-sort-button[aria-pressed="true"] { background: #edf4ff; color: #245eae; border-color: #d7e5fa; }
      #zcs-inline-results .zcs-inline-sort-button:focus-visible { outline: 2px solid #3875d7; outline-offset: 1px; }
      #zcs-inline-results .zcs-inline-head .busy { color: #3569c1; }
      #zcs-inline-results .zcs-inline-head .zcs-inline-settings {
        margin: 0 0 0 auto; min-width: 0; height: auto; min-height: 24px; max-height: none;
        white-space: nowrap; font: 11px/18px system-ui, sans-serif;
      }
      #zcs-inline-results .zcs-inline-notice {
        padding: 7px 14px; color: color-mix(in srgb, currentColor 62%, transparent);
        font-size: 11px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
      }
      #zcs-inline-results .zcs-inline-row {
        display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 9px;
        padding: 12px 16px 13px 10px;
        border-bottom: 1px solid color-mix(in srgb, currentColor 13%, transparent);
      }
      #zcs-inline-results .zcs-inline-row:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
      #zcs-inline-results .zcs-inline-star {
        align-self: start; width: 30px; height: 30px; padding: 0; border: 0;
        border-radius: 4px; background: transparent; color: #9aa4b2;
        font: 23px/30px "Segoe UI Symbol", sans-serif; cursor: pointer;
      }
      #zcs-inline-results .zcs-inline-star[aria-pressed="true"] { color: #ffcc00; text-shadow: 0 1px 1px #00000020; }
      #zcs-inline-results .zcs-inline-star:hover:not(:disabled) { background: color-mix(in srgb, currentColor 12%, transparent); }
      #zcs-inline-results .zcs-inline-star:disabled { opacity: .6; cursor: default; }
      #zcs-inline-results .zcs-inline-content { min-width: 0; }
      #zcs-inline-results .zcs-inline-title {
        /* Override Zotero's native button height so every title line stays in flow. */
        display: block; width: 100%; height: auto; min-height: 0; max-height: none;
        margin: 0; padding: 0; border: 0; background: transparent; white-space: normal;
        color: inherit; text-align: start; font: inherit; font-size: 15px; font-weight: 650;
        line-height: 1.45; overflow-wrap: anywhere; cursor: pointer;
      }
      #zcs-inline-results .zcs-inline-title:hover { color: #3569c1; text-decoration: underline; }
      #zcs-inline-results .zcs-inline-metadata { display: grid; gap: 3px; margin: 7px 0; font-size: 12px; line-height: 1.55; }
      #zcs-inline-results .zcs-inline-meta-field { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
      #zcs-inline-results .zcs-inline-meta-label { flex: none; color: color-mix(in srgb, currentColor 60%, transparent); font-size: 11px; }
      #zcs-inline-results .zcs-inline-meta-value { min-width: 0; overflow-wrap: anywhere; color: color-mix(in srgb, currentColor 88%, transparent); }
      #zcs-inline-results .zcs-inline-publication-line { display: flex; flex-wrap: wrap; column-gap: 18px; row-gap: 3px; }
      #zcs-inline-results .zcs-inline-journal-field { flex: 1 1 160px; }
      #zcs-inline-results .zcs-inline-meta-value[data-missing="true"] { color: color-mix(in srgb, currentColor 50%, transparent); }
      #zcs-inline-results .zcs-inline-tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 7px; }
      #zcs-inline-results .zcs-inline-tag { min-width: 0; max-width: 100%; box-sizing: border-box; padding: 0 5px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 3px; color: color-mix(in srgb, currentColor 62%, transparent); font-size: 10px; }
      #zcs-inline-results .zcs-inline-snippet { margin: 8px 0; padding-inline-start: 9px; border-inline-start: 2px solid #c8d3e5; }
      #zcs-inline-results .zcs-inline-source { margin-bottom: 2px; color: #3569c1; font-size: 10px; font-weight: 600; }
      #zcs-inline-results .zcs-snippet-page { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
      #zcs-inline-results .zcs-snippet-page:hover { text-decoration: underline; }
      #zcs-inline-results .zcs-snippet-page:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
      #zcs-inline-results .zcs-inline-attachment { margin-inline-start: 6px; color: color-mix(in srgb, currentColor 56%, transparent); font-weight: 400; }
      #zcs-inline-results .zcs-inline-snippet p { margin: 0; font-size: 12px; line-height: 1.65; overflow-wrap: anywhere; }
      #zcs-inline-results mark { padding: 0 1px; border-radius: 2px; background: #fff0a8; color: #25251d; font-weight: 650; }
      #zcs-inline-results .zcs-inline-no-snippet { margin: 7px 0; color: color-mix(in srgb, currentColor 58%, transparent); font-size: 11px; }
      #zcs-inline-results .zcs-inline-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 11px; margin-top: 7px; }
      #zcs-inline-results .zcs-inline-action { padding: 0; border: 0; background: transparent; color: #3569c1; font-size: 10px; cursor: pointer; }
      #zcs-inline-results .zcs-inline-action:hover { text-decoration: underline; }
      #zcs-inline-results .zcs-inline-match { margin-inline-start: auto; color: color-mix(in srgb, currentColor 52%, transparent); font-size: 10px; }
      #zcs-inline-results .zcs-inline-empty { margin: auto; padding: 60px 20px; color: color-mix(in srgb, currentColor 58%, transparent); text-align: center; }
      #zcs-inline-results .zcs-inline-empty strong { display: block; margin-bottom: 7px; color: inherit; font-size: 15px; }
      #zcs-inline-results .zcs-inline-loading { margin: auto; padding: 60px 20px; color: #3569c1; text-align: center; }
      #zcs-inline-results .zcs-inline-more { margin: 16px auto; padding: 7px 20px; cursor: pointer; }
      #zcs-inline-results [hidden] { display: none !important; }
      @media (prefers-color-scheme: dark) {
        #zcs-inline-results { background: #202124; color: #e8eaed; }
        #zcs-inline-results .zcs-inline-head { background: #25272b; color: #bdc3ce; border-color: #3c4048; }
        #zcs-inline-results .zcs-inline-head strong { color: #e8eaed; }
        #zcs-inline-results .zcs-inline-sort-button { color: #bdc3ce; }
        #zcs-inline-results .zcs-inline-sort-button:hover { background: #323843; }
        #zcs-inline-results .zcs-inline-sort-button[aria-pressed="true"] { background: #293b55; color: #aacbff; border-color: #466286; }
        #zcs-inline-results mark { background: #e8cb69; }
        #zcs-inline-results .zcs-inline-star[aria-pressed="true"] { color: #ffd43b; text-shadow: none; }
      }
    `;
    this.doc.documentElement.append(this.style);
    this.host = this.element("div");
    this.host.id = "zcs-inline-results";
    this.host.setAttribute("lang", this.l10n.locale);
    this.host.hidden = true;
    this.host.setAttribute("aria-live", "polite");
    pane.append(this.host);
  }

  _showTree(show) {
    if (!this.host || !this.tree) return;
    if (show) {
      this.host.hidden = true;
      this.tree.hidden = this.originalTree?.hidden || false;
      if (this.originalTree?.display) this.tree.style.setProperty("display", this.originalTree.display, this.originalTree.displayPriority);
      else this.tree.style.removeProperty("display");
    }
    else {
      this.tree.hidden = true;
      this.tree.style.setProperty("display", "none", "important");
      this.host.hidden = false;
    }
  }

  showOriginal() {
    if (this.disposed) return;
    this.rows.clear();
    this.host?.replaceChildren();
    this._showTree(true);
  }

  renderLoading(query) {
    if (this.disposed || !this.host) return;
    this._showTree(false);
    this.host.replaceChildren();
    const loading = this.element("div", "zcs-inline-loading", this.t("‘{query}’ 검색 중…", "Searching for “{query}”…", { query }));
    this.host.append(loading);
  }

  renderError(message) {
    if (this.disposed || !this.host) return;
    this._showTree(false);
    this.host.replaceChildren();
    const empty = this.element("div", "zcs-inline-empty");
    empty.append(this.element("strong", "", this.t("검색을 완료하지 못했습니다", "Search could not be completed")),
      this.element("span", "", message || this.t("검색어와 목록 범위를 확인해 주세요.", "Check your query and the current library or collection.")));
    this.host.append(empty);
  }

  render(data, query, loadPage) {
    if (this.disposed || !this.host) return;
    this._showTree(false);
    this.rows.clear();
    this.host.replaceChildren();
    this.host.scrollTop = 0;
    const head = this.element("div", "zcs-inline-head");
    head.append(this.element("strong", "", this.t("전체 검색", "Full Search")),
      this.element("span", "zcs-inline-count", this.t("{count}편", Number(data.total) === 1 ? "{count} result" : "{count} results", { count: this.number(data.total || 0) })));
    const sortMode = this.controller.getSortMode();
    const sorting = this.element("div", "zcs-inline-sort");
    sorting.setAttribute("role", "group");
    sorting.setAttribute("aria-label", this.t("검색 결과 정렬", "Sort search results"));
    const relevance = this.element("button", "zcs-inline-sort-button", this.t("정확도순", "Relevance"));
    relevance.type = "button";
    relevance.dataset.sort = "relevance";
    relevance.setAttribute("aria-pressed", String(sortMode === "relevance"));
    relevance.title = this.t("검색어 전체가 일치하는 문헌부터 표시", "Show complete query matches first");
    relevance.addEventListener("click", () => this.controller.setSortMode("relevance"));
    const oldest = sortMode === "dateAddedAsc";
    const added = this.element("button", "zcs-inline-sort-button", oldest ? this.t("오래된 추가순 ↑", "Oldest Added ↑") : this.t("최근 추가순 ↓", "Recently Added ↓"));
    added.type = "button";
    added.dataset.sort = "dateAdded";
    added.setAttribute("aria-pressed", String(sortMode !== "relevance"));
    added.title = sortMode === "dateAddedDesc"
      ? this.t("서지 추가일 기준 · 누르면 오래된 추가순으로 정렬", "Date added to Zotero · click to show oldest first")
      : this.t("서지 추가일 기준 · 누르면 최근 추가순으로 정렬", "Date added to Zotero · click to show newest first");
    added.addEventListener("click", () => this.controller.setSortMode(sortMode === "dateAddedDesc" ? "dateAddedAsc" : "dateAddedDesc"));
    sorting.append(relevance, added);
    head.append(sorting);
    const settings = this.element("button", "zcs-inline-action zcs-inline-settings", this.t("인용 설정", "Citation Settings"));
    settings.type = "button";
    settings.addEventListener("click", () => this.controller.openPreferences());
    head.append(settings);
    if (data.cancelled) head.append(this.element("span", "busy", this.t("검색 취소됨", "Search cancelled")));
    this.host.append(head);
    if (data.warnings?.length) this.host.append(this.element("div", "zcs-inline-notice", data.warnings.join(" · ")));
    if (!data.results?.length) {
      const empty = this.element("div", "zcs-inline-empty");
      empty.append(this.element("strong", "", this.t("검색 결과가 없습니다", "No results")), this.element("span", "", this.t("다른 검색어를 사용하거나 왼쪽 목록의 범위를 확인해 주세요.", "Try another query or check the selected library or collection.")));
      this.host.append(empty);
      return;
    }
    const fragment = this.doc.createDocumentFragment();
    for (const result of data.results) fragment.append(this.renderResult(result, query));
    this.host.append(fragment);
    this.addMore(data, query, loadPage);
  }

  addMore(data, query, loadPage) {
    if (!data.hasMore || !loadPage) return;
    const more = this.element("button", "zcs-inline-more", this.t("더 보기 ({shown} / {total})", "Load More ({shown} / {total})", { shown: this.number(this.rows.size), total: this.number(data.total) }));
    more.type = "button";
    more.addEventListener("click", async () => {
      more.disabled = true;
      more.textContent = this.t("불러오는 중…", "Loading…");
      try {
        const page = await loadPage(data.nextOffset);
        if (!page || !more.isConnected || this.disposed) return;
        more.remove();
        const fragment = this.doc.createDocumentFragment();
        for (const result of page.results) fragment.append(this.renderResult(result, query));
        this.host.append(fragment);
        if (page.warnings?.length) this.host.append(this.element("div", "zcs-inline-notice", page.warnings.join(" · ")));
        this.addMore(page, query, loadPage);
      }
      catch (error) {
        this.Zotero.logError(error);
        more.textContent = this.t("불러오기 실패 · 다시 시도", "Could not load results · retry");
        more.disabled = false;
      }
    });
    this.host.append(more);
  }

  highlighted(element, text, query, suppliedSegments) {
    // Imported metadata can be arbitrarily large. Bound only its visible DOM;
    // search, ranking, and citation copy still use the complete stored value.
    const value = String(text || "");
    let end = Math.min(value.length, 4096);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    const truncated = !suppliedSegments && end < value.length;
    const segments = suppliedSegments || this.controller.core.highlightSegments(value.slice(0, end), query);
    for (const segment of segments) {
      if (segment.match) element.append(this.element("mark", "", segment.text));
      else element.append(this.doc.createTextNode(segment.text));
    }
    if (truncated) element.append(this.doc.createTextNode("…"));
  }

  setStar(button, value, editable) {
    button.textContent = value ? "★" : "☆";
    button.setAttribute("aria-pressed", String(!!value));
    button.disabled = !editable;
    const label = !editable ? this.t("편집 가능한 서지 항목에서 즐겨찾기를 변경하세요", "Favorites require an editable reference")
      : value ? this.t("즐겨찾기 해제", "Remove from favorites") : this.t("즐겨찾기 추가", "Add to favorites");
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  metadataField(label, value, className, query) {
    const field = this.element("div", "zcs-inline-meta-field");
    field.append(this.element("span", "zcs-inline-meta-label", label));
    const text = this.element("span", "zcs-inline-meta-value " + className);
    text.dataset.missing = String(!value);
    this.highlighted(text, value || this.t("미등록", "Not set"), query);
    field.append(text);
    return field;
  }

  renderResult(result, query) {
    const row = this.element("article", "zcs-inline-row");
    row.dataset.itemId = String(result.id);
    const star = this.element("button", "zcs-inline-star");
    star.type = "button";
    this.setStar(star, result.starred, result.canFavorite);
    star.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      star.disabled = true;
      try {
        await this.controller.favorites.toggle(result.id);
        this.refreshFavorites();
      }
      catch (error) { this.controller.Zotero.logError(error); }
      finally { if (star.isConnected) this.refreshFavorites(); }
    });
    row.append(star);

    const content = this.element("div", "zcs-inline-content");
    let opening = false;
    const openFile = async (snippet) => {
      if (opening) return;
      opening = true;
      try {
        if (snippet?.source === "pdf" && snippet.attachmentID) {
          await this.controller.openAttachment(snippet.attachmentID, this.win, snippet.pageNumber);
        }
        else await this.controller.openResultFile(result, this.win);
      }
      catch (error) { this.controller.reportError(this.t("첨부파일 열기", "Open Attachment"), error); }
      finally { opening = false; }
    };
    const title = this.element("button", "zcs-inline-title");
    title.type = "button";
    title.title = this.t("첨부파일 열기 · 파일이 없으면 서지목록에서 보기", "Open attachment; show in library if no file is available");
    this.highlighted(title, result.title || this.t("제목 없음", "Untitled"), query);
    title.addEventListener("click", openFile);
    content.append(title);
    const metadata = this.element("div", "zcs-inline-metadata");
    const creators = Array.isArray(result.creators) ? result.creators.join("; ") : result.creators;
    metadata.append(this.metadataField(result.creatorsLabel || this.t("저자", "Authors"), creators, "zcs-inline-authors", query));
    const publicationLine = this.element("div", "zcs-inline-publication-line");
    publicationLine.append(this.metadataField(this.t("연도", "Year"), result.year, "zcs-inline-year", query));
    const journal = this.metadataField(result.publicationLabel || this.t("저널", "Journal"), result.publication, "zcs-inline-publication", query);
    journal.classList.add("zcs-inline-journal-field");
    publicationLine.append(journal);
    metadata.append(publicationLine);
    content.append(metadata);
    const tags = (result.tags || []).map(tag => typeof tag === "string" ? tag : tag.tag).filter(tag => tag !== "★");
    if (tags.length) {
      const tagBox = this.element("div", "zcs-inline-tags");
      for (const tag of tags.slice(0, 7)) {
        const chip = this.element("span", "zcs-inline-tag");
        this.highlighted(chip, tag, query); tagBox.append(chip);
      }
      if (tags.length > 7) tagBox.append(this.element("span", "zcs-inline-tag", `+${tags.length - 7}`));
      content.append(tagBox);
    }
    for (const snippet of result.snippets || []) {
      const block = this.element("div", "zcs-inline-snippet");
      const source = this.element("div", "zcs-inline-source");
      if (snippet.source === "pdf" && snippet.attachmentID && Number.isSafeInteger(snippet.pageNumber) && snippet.pageNumber > 0) {
        const end = Number.isSafeInteger(snippet.endPageNumber) && snippet.endPageNumber > snippet.pageNumber
          ? `–${snippet.endPageNumber}` : "";
        const page = this.element("button", "zcs-snippet-page", `PDF ${end ? "pp." : "p."} ${snippet.pageNumber}${end}`);
        page.type = "button";
        page.dataset.pageNumber = String(snippet.pageNumber);
        page.title = this.t("PDF p. {page} 열기", "Open PDF at p. {page}", { page: snippet.pageNumber });
        page.setAttribute("aria-label", page.title);
        page.addEventListener("click", () => openFile(snippet));
        source.append(page);
      }
      else {
        const label = { pdf: this.t("PDF 본문", "PDF text"), abstract: this.t("초록", "Abstract"), note: this.t("노트", "Note"), text: this.t("첨부 본문", "Attachment text") }[snippet.source] || this.t("첨부 본문", "Attachment text");
        source.append(this.element("span", "", label));
      }
      if (snippet.attachmentTitle && !/^pdf$/i.test(snippet.attachmentTitle.trim())) {
        source.append(this.element("span", "zcs-inline-attachment", snippet.attachmentTitle));
      }
      const paragraph = this.element("p");
      this.highlighted(paragraph, snippet.text, query, snippet.segments);
      block.append(source, paragraph); content.append(block);
    }
    if (query && !result.snippets?.length) content.append(this.element("p", "zcs-inline-no-snippet", this.t("검색 결과는 있으나 표시할 일치 문맥이 없습니다.", "This reference matches, but no matching passage is available.")));
    const actions = this.element("div", "zcs-inline-actions");
    const select = this.element("button", "zcs-inline-action", this.t("서지목록에서 보기", "Show in Library"));
    select.type = "button"; select.addEventListener("click", () => this.controller.selectItem(result.id, this.win).catch(error => this.controller.reportError(this.t("서지목록에서 보기", "Show in Library"), error)));
    actions.append(select);
    const copy = this.element("button", "zcs-inline-action", this.t("짧은 인용 복사", "Copy Short Citation"));
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try { await this.controller.citation.copy([result.id]); copy.textContent = this.t("복사됨 ✓", "Copied ✓"); }
      catch (error) { this.controller.Zotero.logError(error); copy.textContent = this.t("복사 실패 · 다시 시도", "Copy failed · retry"); }
    });
    actions.append(copy);
    const copyLong = this.element("button", "zcs-inline-action", this.t("긴 인용 복사", "Copy Long Citation"));
    copyLong.type = "button";
    copyLong.addEventListener("click", async () => {
      try { await this.controller.citation.copy([result.id], { style: "long" }); copyLong.textContent = this.t("복사됨 ✓", "Copied ✓"); }
      catch (error) { this.controller.reportError(this.t("긴 인용 복사", "Copy Long Citation"), error); }
    });
    actions.append(copyLong);
    if (result.hasPDF) {
      const open = this.element("button", "zcs-inline-action", this.t("PDF 열기 ↗", "Open PDF ↗"));
      open.type = "button";
      open.addEventListener("click", openFile);
      actions.append(open);
    }
    const names = { title: this.t("제목", "Title"), author: this.t("저자", "Author"), creators: this.t("저자", "Author"),
      tags: this.t("태그", "Tags"), tag: this.t("태그", "Tags"), abstract: this.t("초록", "Abstract"),
      fulltext: this.t("본문", "Full text"), pdf: this.t("본문", "Full text"), note: this.t("노트", "Note"),
      publication: this.t("학술지", "Journal"), year: this.t("연도", "Year"),
      indexedFulltext: this.t("색인 본문", "Indexed text"), nativeSearch: this.t("Zotero 검색", "Zotero search") };
    const labels = [...new Set((result.matchedFields || []).map(field => names[field] || field))];
    if (labels.length) actions.append(this.element("span", "zcs-inline-match", this.t("{fields} 일치", "Matched: {fields}", { fields: labels.join(" · ") })));
    content.append(actions);
    row.append(content);
    this.rows.set(result.id, { result, star });
    return row;
  }

  refreshFavorites() {
    if (this.disposed) return;
    for (const [id, entry] of this.rows) {
      const item = this.Zotero.Items.get(id);
      if (!item) continue;
      this.setStar(entry.star, this.controller.favorites.has(item), entry.result.canFavorite);
      entry.result.starred = this.controller.favorites.has(item);
    }
  }

  destroy() {
    this.disposed = true;
    this.rows.clear();
    if (this.host) this.host.remove();
    if (this.style) this.style.remove();
    if (this.tree && this.originalTree) {
      this.tree.hidden = this.originalTree.hidden;
      if (this.originalTree.display) this.tree.style.setProperty("display", this.originalTree.display, this.originalTree.displayPriority);
      else this.tree.style.removeProperty("display");
    }
    this.host = null;
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = ZCSInlineUI;
