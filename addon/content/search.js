/* Uses Zotero's existing native search index. Never extracts, indexes, or downloads a PDF. */
var ZCSSearch = class {
  constructor({ Zotero, core, l10n }) {
    this.Zotero = Zotero;
    this.core = core;
    this.l10n = l10n || (typeof ZCSL10n !== "undefined" ? ZCSL10n : require("./localization.js")).create({ Zotero });
    this._textCache = new Map();
    this._cacheChars = 0;
    this._maxCacheChars = 4000000;
    this._phraseCache = new Map();
    this._cacheGeneration = 0;
  }

  clearCache() {
    this._textCache.clear(); this._cacheChars = 0;
    this._phraseCache.clear(); this._cacheGeneration++;
  }

  invalidate() { this.clearCache(); }

  destroy() { this.clearCache(); }

  async _load(item, types) {
    if (!item || !item.loadDataType) return;
    for (const type of types) await item.loadDataType(type);
  }

  _field(item, name) {
    try { return String(item.getField(name) || ""); } catch (_) { return ""; }
  }

  _parent(item) {
    const seen = new Set();
    while (item && !item.isRegularItem?.() && item.parentItemID && !seen.has(item.id)) {
      seen.add(item.id);
      item = this.Zotero.Items.get(item.parentItemID);
    }
    return item;
  }

  _candidates(items, isCancelled) {
    const candidates = [], seen = new Set();
    for (const entry of Array.isArray(items) ? items : []) {
      this._cancelled(isCancelled);
      const item = this._parent(typeof entry === "object" ? entry : this.Zotero.Items.get(entry));
      if (!item || item.deleted || item.isFeedItem || seen.has(item.id)) continue;
      seen.add(item.id); candidates.push(item);
    }
    return candidates;
  }

  _dateAdded(item) {
    // dateAdded belongs to the bibliography item. It is unrelated to the
    // publication's `date` field or any attachment's download/import date.
    const value = String(item.dateAdded || this._field(item, "dateAdded") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.test(value)) return null;
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    const calendarDate = new Date(0);
    calendarDate.setUTCFullYear(year, month - 1, day);
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return null;
    let iso = value.replace(" ", "T");
    if (!iso.includes("T")) iso += "T00:00:00";
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += "Z";
    const timestamp = Date.parse(iso);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  async sortNativeResults({ query = "", items = [], sortMode = "relevance", isCancelled = () => false } = {}) {
    if (sortMode === "relevance") return this.rankNativeResults({ query, items, isCancelled });
    if (!["dateAddedDesc", "dateAddedAsc"].includes(sortMode)) throw new Error(this.l10n.t("지원하지 않는 검색 결과 정렬입니다.", "This search result sort order is not supported."));
    const candidates = this._candidates(items, isCancelled);
    const dated = [];
    for (let index = 0; index < candidates.length; index++) {
      if (index % 50 === 0) await this._yield(isCancelled);
      const item = candidates[index];
      if (typeof item.loadPrimaryData === "function") await item.loadPrimaryData();
      else await this._load(item, ["primaryData"]);
      this._cancelled(isCancelled);
      dated.push({ item, index, time: this._dateAdded(item) });
    }
    const direction = sortMode === "dateAddedAsc" ? 1 : -1;
    dated.sort((a, b) => {
      if (a.time === null || b.time === null) {
        return Number(a.time === null) - Number(b.time === null) || a.index - b.index;
      }
      return direction * (a.time - b.time) || a.index - b.index;
    });
    this._cancelled(isCancelled);
    return dated.map(row => row.item);
  }

  async _nativePhraseMatches(phrase, libraryID, candidates, isCancelled) {
    const ids = candidates.map(item => item.id).sort((a, b) => a - b);
    const cacheKey = JSON.stringify([phrase, libraryID, ids]);
    const old = this._phraseCache.get(cacheKey);
    if (old && Date.now() - old.time < 30000) return old.ids;
    const nativeSearch = new this.Zotero.Search();
    if (typeof this.Zotero.Search.idsToTempTable !== "function"
        || typeof nativeSearch.setScope !== "function" || !this.Zotero.DB?.queryAsync) {
      this.Zotero.debug?.("Context Search: scoped native phrase search is unavailable; using metadata relevance.");
      return new Set();
    }
    const generation = this._cacheGeneration;
    let table;
    try {
      this._cancelled(isCancelled);
      // Zotero's transient search scope bounds its own index/cache lookup to
      // these already-visible parents and children. No persistent index is built.
      table = await this.Zotero.Search.idsToTempTable(ids, { idColumn: "id" });
      if (typeof table !== "string" || !/^tmpSearchResults_[A-Za-z0-9_]+$/.test(table)) {
        table = null;
        throw new Error("Unexpected native search scope identifier");
      }
      this._cancelled(isCancelled);
      const scope = new this.Zotero.Search();
      scope.libraryID = libraryID;
      scope.addCondition("tempTable", "is", table);
      nativeSearch.libraryID = libraryID;
      nativeSearch.setScope(scope, true);
      nativeSearch.addCondition("fulltextContent", "contains", phrase);
      const nativeIDs = await nativeSearch.search();
      this._cancelled(isCancelled);
      const hits = nativeIDs.length ? await this.Zotero.Items.getAsync(nativeIDs) : [];
      this._cancelled(isCancelled);
      const allowed = new Set(ids), matched = new Set();
      for (const hit of hits) {
        const item = this._parent(hit);
        if (item && !item.deleted && item.libraryID === libraryID && allowed.has(item.id)) matched.add(item.id);
      }
      if (generation === this._cacheGeneration) {
        while (this._phraseCache.size >= 8) this._phraseCache.delete(this._phraseCache.keys().next().value);
        this._phraseCache.set(cacheKey, { ids: matched, time: Date.now() });
      }
      return matched;
    }
    finally {
      if (table) {
        try { await this.Zotero.DB.queryAsync("DROP TABLE IF EXISTS " + table, false, { noCache: true }); }
        catch (error) { this.Zotero.logError?.(error); }
      }
    }
  }

  /** Rank the complete native result set before taking any display page. */
  async rankNativeResults({ query = "", items = [], isCancelled = () => false } = {}) {
    query = String(query).trim();
    if (query.length > 1024) throw new Error(this.l10n.t("검색어는 1024자 이하로 입력해 주세요.", "Enter a search query of 1024 characters or fewer."));
    const candidates = this._candidates(items, isCancelled);
    const info = this.core.queryInfo(query);
    if (!info.terms.length || candidates.length < 2) return candidates;
    const ranked = [], libraries = new Map();
    for (let index = 0; index < candidates.length; index++) {
      if (index % 25 === 0) await this._yield(isCancelled);
      const item = candidates[index];
      await this._load(item, ["itemData", "creators", "tags"]);
      this._cancelled(isCancelled);
      const textOptions = { isCancelled, yieldControl: () => this._yield(isCancelled) };
      const title = await this.core.relevanceAsync(this._field(item, "title"), info, textOptions);
      const metadata = [];
      for (const value of [
        this._field(item, "abstractNote"), this._field(item, "publicationTitle"),
        this._field(item, "journalAbbreviation"), this._field(item, "bookTitle"),
        this._field(item, "proceedingsTitle"), this._field(item, "date"),
        ...item.getTags().map(tag => tag.tag),
        ...item.getCreators().map(creator => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" ")),
      ].filter(Boolean)) metadata.push(await this.core.relevanceAsync(value, info, textOptions));
      const exactMetadata = metadata.some(match => match.exactPhrase);
      const allMetadata = metadata.some(match => match.allTerms);
      const mostMetadata = Math.max(0, ...metadata.map(match => match.matchedTerms));
      const tier = title.exactPhrase ? 5 : exactMetadata ? 4 : title.allTerms ? 3 : allMetadata ? 2 : 1;
      ranked.push({ item, index, tier, titleTerms: title.matchedTerms, metadataTerms: mostMetadata });
      if (!libraries.has(item.libraryID)) libraries.set(item.libraryID, []);
      libraries.get(item.libraryID).push(item);
    }
    // A quoted phrase is still multiword. Single-word typing never triggers an
    // extra body lookup; its partial native matches remain visible below exact words.
    if (info.multiword) {
      for (const [libraryID, scoped] of libraries) {
        try {
          const matched = await this._nativePhraseMatches(info.phrase, libraryID, scoped, isCancelled);
          for (const row of ranked) if (matched.has(row.item.id) && row.tier < 4) row.tier = 4;
        }
        catch (error) {
          if (error.name === "AbortError") throw error;
          this.Zotero.logError?.(error);
        }
        this._cancelled(isCancelled);
      }
    }
    ranked.sort((a, b) => b.tier - a.tier || b.titleTerms - a.titleTerms
      || b.metadataTerms - a.metadataTerms || a.index - b.index);
    this._cancelled(isCancelled);
    return ranked.map(row => row.item);
  }

  _cancelled(isCancelled) {
    if (isCancelled()) {
      const error = new Error("Search cancelled");
      error.name = "AbortError";
      throw error;
    }
  }

  async _yield(isCancelled) {
    // Promise-only cache hits don't yield to input events. Let typing/clearing the query
    // cancel a long cached-result page between documents, without starting background work.
    if (this.Zotero.Promise?.delay) await this.Zotero.Promise.delay(0);
    this._cancelled(isCancelled);
  }

  async _readCache(item, isCancelled) {
    this._cancelled(isCancelled);
    const key = item.id;
    const old = this._textCache.get(key);
    if (old && old.modified === item.dateModified && Date.now() - old.time < 30000) {
      this._textCache.delete(key); this._textCache.set(key, old);
      return old;
    }
    if (old) { this._textCache.delete(key); this._cacheChars -= old.text.length; }
    const fulltext = this.Zotero.Fulltext || this.Zotero.FullText;
    const file = fulltext.getItemCacheFile(item);
    // Read the entire extracted cache: a prefix cap would miss hits later in a paper.
    const text = String(await this.Zotero.File.getContentsAsync(file.path || file));
    this._cancelled(isCancelled);
    let indexedPages;
    try {
      const stats = await fulltext.getPages?.(item.id);
      if (Number.isSafeInteger(stats?.indexedPages) && stats.indexedPages > 0) indexedPages = stats.indexedPages;
    }
    catch (_) { /* Page metadata is optional; retain the existing text preview. */ }
    this._cancelled(isCancelled);
    const entry = { text, indexedPages, time: Date.now(), modified: item.dateModified };
    if (text.length <= this._maxCacheChars) {
      while (this._cacheChars + text.length > this._maxCacheChars || this._textCache.size >= 24) {
        const first = this._textCache.keys().next().value;
        this._cacheChars -= this._textCache.get(first).text.length;
        this._textCache.delete(first);
      }
      this._textCache.set(key, entry);
      this._cacheChars += text.length;
    }
    return entry;
  }

  _makeSearch(query, libraryID, favoritesOnly, field) {
    const search = new this.Zotero.Search();
    search.libraryID = libraryID;
    // Result level maps attachment/note matches to their top-level bibliographic item.
    // It also lets different query terms match the parent and a child independently.
    search.addCondition("resultLevel", "item");
    if (query) {
      if (field === "all") search.addCondition("quicksearch-everything", "contains", query);
      else {
        const condition = { title: "title", author: "creator", tags: "tag", fulltext: "fulltextContent" }[field];
        for (const part of this.core.parseQuery(query)) search.addCondition(condition, "contains", part.text);
      }
    }
    if (favoritesOnly) {
      search.addCondition("tag", "is", "★");
    }
    return search;
  }

  async _result(item, query, field, libraryID, isCancelled, warnings) {
    this._cancelled(isCancelled);
    await this._load(item, ["itemData", "creators", "tags", "childItems"]);
    const tags = item.getTags().map(tag => tag.tag);
    const allCreators = item.getCreators();
    const authorType = this.Zotero.CreatorTypes?.getID?.("author") ?? 1;
    const authors = allCreators.filter(creator => creator.creatorTypeID === authorType || creator.creatorType === "author");
    const creators = (authors.length ? authors : allCreators).map(creator => creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" ")).join(", ");
    const creatorsLabel = authors.length || !allCreators.length ? this.l10n.t("저자", "Authors") : this.l10n.t("기여자", "Contributors");
    const title = this._field(item, "title") || this.l10n.t("제목 없음", "Untitled");
    const journal = this._field(item, "publicationTitle") || this._field(item, "journalAbbreviation");
    const book = this._field(item, "bookTitle");
    const proceedings = this._field(item, "proceedingsTitle");
    const publication = journal || book || proceedings;
    const publicationLabel = journal ? this.l10n.t("저널", "Journal") : book ? this.l10n.t("수록도서", "Book")
      : proceedings ? this.l10n.t("학술대회", "Conference") : this.l10n.t("저널", "Journal");
    const date = this._field(item, "date");
    const year = (date.match(/\b\d{4}\b/u) || [""])[0];
    const matchedFields = [];
    for (const [name, value] of [["title", title], ["author", creators], ["tags", tags.join(" ")], ["year", year], ["publication", publication]]) {
      if (query && await this.core.matchesTextAsync(value, query, {
        isCancelled, yieldControl: () => this._yield(isCancelled),
      })) matchedFields.push(name);
    }
    const snippets = [];
    const compareSnippets = (a, b) => Number(b.relevance?.exactPhrase) - Number(a.relevance?.exactPhrase)
      || Number(b.relevance?.allTerms) - Number(a.relevance?.allTerms)
      || (b.relevance?.matchedTerms || 0) - (a.relevance?.matchedTerms || 0);
    const addSnippets = async (text, source, child, indexedPages) => {
      const found = await this.core.findSnippetsAsync(text, query, {
        maxSnippets: 3, indexedPages: source === "pdf" ? indexedPages : undefined,
        isCancelled, yieldControl: () => this._yield(isCancelled),
      });
      if (found.length && !matchedFields.includes(source === "pdf" ? "fulltext" : source)) matchedFields.push(source === "pdf" ? "fulltext" : source);
      for (const snippet of found) snippets.push({ ...snippet, source, attachmentID: child ? child.id : null, attachmentTitle: child ? this._field(child, "title") : "" });
      // Bound retained excerpts across every attachment/note, not only within
      // one text. Later complete phrases can still displace earlier fragments.
      snippets.sort(compareSnippets); snippets.splice(3);
    };
    const isAttachment = item.isAttachment();
    const isNote = item.isNote();
    const attachmentIDs = isAttachment ? [item.id] : isNote ? [] : item.getAttachments();
    const attachments = attachmentIDs.length ? await this.Zotero.Items.getAsync(attachmentIDs) : [];
    const pdfs = attachments.filter(child => child && !child.deleted && child.libraryID === libraryID && child.attachmentContentType === "application/pdf");
    if (query && (field === "all" || field === "fulltext")) {
      for (const pdf of pdfs) {
        this._cancelled(isCancelled);
        try {
          const cached = await this._readCache(pdf, isCancelled);
          await addSnippets(cached.text, "pdf", pdf, cached.indexedPages);
        }
        catch (error) {
          if (error.name === "AbortError") throw error;
          warnings.add(this.l10n.t("일부 PDF의 기존 추출 텍스트를 읽을 수 없어 문맥을 표시하지 못했습니다. PDF 다운로드나 재색인은 실행하지 않았습니다.", "Context could not be shown for some PDFs because their existing extracted text was unavailable. No PDFs were downloaded or reindexed."));
        }
      }
      if (field === "all") await addSnippets(this._field(item, "abstractNote"), "abstract", null);
      if (field === "all") {
        const noteIDs = isNote ? [item.id] : isAttachment ? [] : item.getNotes();
        const notes = noteIDs.length ? await this.Zotero.Items.getAsync(noteIDs) : [];
        for (const note of notes) {
          this._cancelled(isCancelled);
          if (!note || note.deleted || note.libraryID !== libraryID) continue;
          await this._load(note, ["note"]);
          await addSnippets(this.core.noteText(note.getNote()), "note", note);
        }
      }
    }
    if (query && !matchedFields.length) matchedFields.push(field === "fulltext" ? "indexedFulltext" : "nativeSearch");
    const editable = typeof item.isEditable === "function" ? item.isEditable() : !!this.Zotero.Libraries.get(libraryID).editable;
    return {
      id: item.id, title, creators, creatorsLabel, year, publication, publicationLabel, tags,
      starred: this.core.isStarred(tags),
      editable,
      canFavorite: editable && !!item.isRegularItem?.() && !item.isFeedItem,
      matchedFields, snippets, hasPDF: pdfs.length > 0,
      attachmentID: pdfs.length ? pdfs[0].id : null,
    };
  }

  async search({ query = "", libraryID, favoritesOnly = false, field = "all", offset = 0, limit = 40, isCancelled = () => false } = {}) {
    query = String(query).trim();
    if (query.length > 1024) throw new Error(this.l10n.t("검색어는 1024자 이하로 입력해 주세요.", "Enter a search query of 1024 characters or fewer."));
    field = { authors: "author", creator: "author", tag: "tags", pdf: "fulltext", content: "fulltext" }[field] || field;
    if (!["all", "title", "author", "tags", "fulltext"].includes(field)) throw new Error(this.l10n.t("알 수 없는 검색 필드: {field}", "Unknown search field: {field}", { field }));
    libraryID = libraryID == null ? this.Zotero.Libraries.userLibraryID : Number(libraryID);
    if (!Number.isInteger(libraryID) || !this.Zotero.Libraries.get(libraryID)) throw new Error(this.l10n.t("유효한 라이브러리를 선택해 주세요.", "Select a valid library."));
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    limit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 40)));
    const warnings = new Set();
    try {
      this._cancelled(isCancelled);
      if (query && (!this.core.parseQuery(query).length || !query.replace(/["\s]/gu, ""))) {
        return {
          results: [], total: 0, hasMore: false, nextOffset: 0, offset, limit,
          warnings: [this.l10n.t("따옴표 안에 검색어를 입력해 주세요.", "Enter a search term inside the quotation marks.")], cancelled: false,
        };
      }
      const nativeSearch = this._makeSearch(query, libraryID, favoritesOnly, field);
      const ids = Array.from(new Set(await nativeSearch.search())).sort((a, b) => b - a);
      this._cancelled(isCancelled);
      if (field === "all" && query && this.Zotero.FullText && this.Zotero.FullText.canSearchContent) {
        if (this.core.parseQuery(query).some(part => !part.inQuotes && !this.Zotero.FullText.canSearchContent(part.text))) {
          warnings.add(this.l10n.t("Zotero 기본 검색은 일부 짧은 단어의 PDF 본문 검색을 생략합니다. 본문 필터 또는 큰따옴표를 사용해 검색하세요.", "Zotero's default search skips PDF text searches for some short words. Use the full-text filter or enclose the words in double quotation marks."));
        }
      }
      const results = [];
      const pageIDs = ids.slice(offset, offset + limit);
      const items = pageIDs.length ? await this.Zotero.Items.getAsync(pageIDs) : [];
      for (const item of items) {
        await this._yield(isCancelled);
        // Native resultLevel and search already exclude trashed children/parents. Recheck
        // here because an item can be moved to the trash while an async search is running.
        if (!item || item.deleted || item.libraryID !== libraryID) continue;
        results.push(await this._result(item, query, field, libraryID, isCancelled, warnings));
      }
      return { results, total: ids.length, hasMore: offset + limit < ids.length, nextOffset: Math.min(ids.length, offset + limit), offset, limit, warnings: [...warnings], cancelled: false };
    } catch (error) {
      if (error.name === "AbortError") return { results: [], total: 0, hasMore: false, offset, limit, warnings: [], cancelled: true };
      throw error;
    }
  }

  /**
   * Enrich the already filtered native rows, without issuing another search.
   * Zotero owns collection/tag scope, search mode and ordering.
   */
  async presentNativeResults({ query = "", items = [], offset = 0, limit = 40, isCancelled = () => false } = {}) {
    query = String(query).trim();
    if (query.length > 1024) throw new Error(this.l10n.t("검색어는 1024자 이하로 입력해 주세요.", "Enter a search query of 1024 characters or fewer."));
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    limit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 40)));
    const warnings = new Set();
    try {
      this._cancelled(isCancelled);
      if (query && (!this.core.parseQuery(query).length || !query.replace(/["\s]/gu, ""))) {
        return {
          results: [], total: 0, hasMore: false, nextOffset: 0, offset, limit,
          warnings: [this.l10n.t("따옴표 안에 검색어를 입력해 주세요.", "Enter a search term inside the quotation marks.")], cancelled: false,
        };
      }

      // Quick-search results can contain expanded attachments or notes. Map
      // them back to their regular parent while retaining the visible order.
      const candidates = this._candidates(items, isCancelled);

      if (query && this.Zotero.FullText?.canSearchContent
          && this.core.parseQuery(query).some(part => !part.inQuotes && !this.Zotero.FullText.canSearchContent(part.text))) {
        warnings.add(this.l10n.t("일부 짧은 단어는 Zotero 본문 검색에서 생략됩니다. 큰따옴표로 감싸서 검색해 보세요.", "Zotero skips some short words in full-text searches. Enclose them in double quotation marks to search."));
      }
      const total = candidates.length;
      const results = [];
      for (const item of candidates.slice(offset, offset + limit)) {
        await this._yield(isCancelled);
        if (!item.deleted) results.push(await this._result(item, query, "all", item.libraryID, isCancelled, warnings));
      }
      return {
        results, total, hasMore: offset + limit < total,
        nextOffset: Math.min(total, offset + limit), offset, limit,
        warnings: [...warnings], cancelled: false,
      };
    }
    catch (error) {
      if (error.name === "AbortError") return { results: [], total: 0, hasMore: false, offset, limit, warnings: [], cancelled: true };
      throw error;
    }
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = ZCSSearch;
