/* global Zotero */
"use strict";

var ZCSController = class {
  constructor({ Zotero, Services, rootURI, id, version, core, Search, Favorites, Citation, InlineUI, Preferences, FileCopy }) {
    Object.assign(this, { Zotero, Services, rootURI, id, version, core });
    this.l10n = (typeof ZCSL10n !== "undefined" ? ZCSL10n : require("./localization.js")).create({ Zotero, Services });
    this.search = new Search({ Zotero, core, l10n: this.l10n });
    this.preferences = new Preferences({ Zotero, Services, rootURI, id, l10n: this.l10n });
    this.citation = new Citation({ Zotero, preferences: this.preferences, l10n: this.l10n });
    this.fileCopy = new FileCopy({ Zotero, Services, l10n: this.l10n });
    this.InlineUI = InlineUI;
    this.favorites = new Favorites({
      Zotero, pluginID: id, l10n: this.l10n,
      onChange: () => this.refreshFavorites(),
      log: error => Zotero.logError(error)
    });
    this.windows = new Map();
    this.inlineWindows = new Map();
    this.destroyed = false;
  }

  t(ko, en, args) {
    this.l10n ||= (typeof ZCSL10n !== "undefined" ? ZCSL10n : require("./localization.js")).create(this);
    return this.l10n.t(ko, en, args);
  }

  async init() {
    this.previousSearchMode = this.Zotero.Prefs.get("search.quicksearch-mode");
    this.Zotero.Prefs.set("search.quicksearch-mode", "everything");
    await this.favorites.init();
    await this.preferences.init();
    const citationMenu = (style, l10nID) => ({
      menuType: "menuitem", l10nID,
      onShowing: (_event, context) => context.setEnabled(context.items?.some(item => item.isRegularItem() || item.parentItemID)),
      onCommand: (_event, context) => this.citation.copy((context.items || []).map(item => item.id), { style })
        .catch(error => this.reportError(style === "long" ? this.t("긴 인용 복사", "Copy Long Citation") : this.t("짧은 인용 복사", "Copy Short Citation"), error)),
    });
    this.citationMenuID = this.Zotero.MenuManager.registerMenu({
      menuID: "context-search-copy-citation", pluginID: this.id,
      target: "main/library/item",
      menus: [
        citationMenu("short", "zcs-copy-citation"),
        citationMenu("long", "zcs-copy-long-citation"),
        {
          menuType: "menuitem", l10nID: "zcs-copy-original-file",
          onShowing: (_event, context) => context.setEnabled(this.fileCopy.canCopy(context.items || [])),
          onCommand: async (_event, context) => {
            try {
              const result = await this.fileCopy.copy((context.items || []).map(item => item.id));
              if (result.skipped.length) this.Services.prompt.alert(this.Zotero.getMainWindow(), this.t("원본 파일 복사", "Copy Original File"), result.message);
            }
            catch (error) { this.reportError(this.t("원본 파일 복사", "Copy Original File"), error); }
          },
        },
      ]
    });
    this.notifierID = this.Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => {
        // No index maintenance or background search; only invalidate our small cache.
        this.search.invalidate?.(ids);
        if (type === "item-tag" || type === "tag" || type === "item") {
          this.refreshFavorites();
        }
      }
    }, ["item", "item-tag", "tag", "file"], "context-search");
    for (const win of this.Zotero.getMainWindows()) this.addToWindow(win);
  }

  reportError(title, error) {
    this.Zotero.logError(error);
    this.Services.prompt.alert(this.Zotero.getMainWindow(), title, error.message || String(error));
  }

  openPreferences() {
    this.Zotero.Utilities.Internal.openPreferences(this.preferences.paneID || "zcs-citation-preferences");
  }

  getSortMode() {
    let mode;
    try { mode = this.Zotero.Prefs.get("contextSearch.sortMode"); }
    catch (_) { /* The first run has no saved sorting preference. */ }
    return ["relevance", "dateAddedDesc", "dateAddedAsc"].includes(mode) ? mode : "relevance";
  }

  setSortMode(mode) {
    if (!["relevance", "dateAddedDesc", "dateAddedAsc"].includes(mode)) {
      throw new Error(this.t("유효한 검색 결과 정렬을 선택해 주세요.", "Choose a valid search result order."));
    }
    if (this.destroyed) return this.getSortMode();
    this.Zotero.Prefs.set("contextSearch.sortMode", mode);
    for (const inline of this.inlineWindows.values()) inline.refreshSearch?.();
    return mode;
  }

  addToWindow(win) {
    if (this.destroyed || this.windows.has(win)) return;
    const doc = win.document;
    win.MozXULElement.insertFTLIfNeeded("context-search.ftl");
    const cleanup = [];
    this.favorites.addToWindow?.(win);
    const inline = this.InlineUI ? new this.InlineUI({ Zotero: this.Zotero, controller: this, win }) : null;
    inline?.addToWindow();
    if (inline) this.inlineWindows.set(win, inline);
    cleanup.push(() => inline?.destroy());
    cleanup.push(...this._installInlineSearch(win, inline));
    this.windows.set(win, cleanup);
  }

  _isNormalView(view) {
    if (!view) return false;
    // Zotero 10 added viewMode and removed the singular collectionTreeRow.
    // Only access the old property when the new API is unavailable.
    if (typeof view.viewMode === "string") return view.viewMode === "default";
    const row = view.collectionTreeRow;
    if (!row || row.isFeed?.() || row.isFeeds?.()) return false;
    return !!(row.isLibrary?.(true) || row.isCollection?.() || row.isSearch?.());
  }

  _installInlineSearch(win, inline) {
    const doc = win.document;
    const quick = doc.getElementById("zotero-tb-search");
    if (!quick || !inline) return [];
    const pane = () => win.ZoteroPane_Local || win.ZoteroPane;
    const inputValue = () => String(quick.searchTextbox?.value ?? quick.value ?? "").trim();
    const itemsView = () => pane()?.itemsView;
    const cleanup = [];
    let timer = null;
    let serial = 0;
    let running = 0;
    let closed = false;
    let refreshVersion = 0;
    let refreshRequested = false;
    quick.updateMode?.();

    // Zotero 10 already provides a clear icon inside search-textbox's shadow
    // DOM. Use it when available so the plugin does not add a second × beside
    // the field; the toolbar fallback is for older compatible builds only.
    const nativeClearButton = quick.searchTextbox?.shadowRoot?.querySelector?.(".textbox-search-clear");
    const ownClearButton = !nativeClearButton;
    const clearButton = nativeClearButton || doc.getElementById("zcs-search-clear") || doc.createXULElement("toolbarbutton");
    if (ownClearButton && !clearButton.id) {
      clearButton.id = "zcs-search-clear";
      clearButton.className = "zotero-tb-button";
      clearButton.setAttribute("label", "×");
      clearButton.setAttribute("tooltiptext", this.t("검색어 지우기", "Clear search"));
      clearButton.setAttribute("aria-label", this.t("검색어 지우기", "Clear search"));
      clearButton.style.cssText = "min-width:24px; width:24px; margin-inline:1px; padding:0; font-size:18px; line-height:1;";
      const parent = quick.parentNode;
      if (parent) parent.insertBefore(clearButton, quick.nextSibling);
    }
    const setClearVisibility = visible => { if (ownClearButton) clearButton.hidden = !visible; };
    setClearVisibility(!!inputValue());

    const restore = () => {
      serial++;
      if (timer !== null) { win.clearTimeout(timer); timer = null; }
      setClearVisibility(false);
      inline.showOriginal();
    };
    const run = async (token, updateNative) => {
      if (token !== serial || this.destroyed || closed) return;
      timer = null;
      const query = inputValue();
      setClearVisibility(!!query);
      if (!query || !this._isNormalView(itemsView())) { restore(); return; }
      inline.renderLoading(query);
      running++;
      try {
        // The native tree owns matching, collection/tag scope and sort order.
        // Force quoted phrases to run automatically too (normally Enter-only).
        if (updateNative) await pane()?.search?.(true);
        refreshRequested = false;
        const version = refreshVersion;
        const cancelled = () => closed || this.destroyed || token !== serial
          || inputValue() !== query || version !== refreshVersion;
        if (cancelled()) return;
        const candidates = await this.search.sortNativeResults({
          query, items: itemsView()?.getSortedItems(false) || [], sortMode: this.getSortMode(), isCancelled: cancelled,
        });
        if (cancelled()) return;
        const loadPage = async offset => {
          const data = await this.search.presentNativeResults({
            query, items: candidates, offset, limit: 40, isCancelled: cancelled,
          });
          if (cancelled() || data.cancelled) return null;
          return data;
        };
        const data = await loadPage(0);
        if (data) inline.render(data, query, loadPage);
      }
      catch (error) {
        if (error.name !== "AbortError" && token === serial && inputValue() === query) {
          this.Zotero.logError(error);
          inline.renderError(this.t("검색어와 현재 목록 범위를 확인해 주세요.", "Check your query and the current library or collection."));
        }
      }
      finally {
        running--;
        if (!closed && !this.destroyed && !running && refreshRequested && inputValue() && timer === null) {
          refreshRequested = false;
          schedule(80, false);
        }
      }
    };
    const schedule = (delay = 280, updateNative = true) => {
      serial++;
      const token = serial;
      if (timer !== null) win.clearTimeout(timer);
      timer = win.setTimeout(() => run(token, updateNative), delay);
    };
    const refreshSearch = () => {
      if (closed || this.destroyed) return;
      if (!inputValue()) { restore(); return; }
      schedule(0, false);
    };
    inline.refreshSearch = refreshSearch;
    const onInput = () => {
      const query = inputValue();
      setClearVisibility(!!query);
      if (!query) {
        restore();
        pane()?.search?.(true).catch(error => this.Zotero.logError(error));
        return;
      }
      schedule();
    };
    const onCommand = () => {
      const query = inputValue();
      setClearVisibility(!!query);
      if (!query) { restore(); return; }
      schedule(0);
    };
    const clear = async () => {
      serial++;
      if (timer !== null) { win.clearTimeout(timer); timer = null; }
      try {
        if (quick.searchTextbox) quick.searchTextbox.value = "";
        else quick.value = "";
        await pane()?.search?.(true);
      }
      catch (error) { this.Zotero.logError(error); }
      restore();
    };
    inline.clearSearch = clear;
    const onClear = event => {
      event.preventDefault(); event.stopImmediatePropagation();
      clear();
    };
    const onRefresh = () => {
      refreshVersion++;
      // Collection changes clear Zotero's native search textbox without
      // dispatching an input event. Restore the normal list in that case.
      if (!inputValue()) { restore(); return; }
      if (running) { refreshRequested = true; return; }
      if (!running && timer === null) schedule(80, false);
    };
    quick.addEventListener("input", onInput);
    quick.addEventListener("command", onCommand);
    const clearEvent = ownClearButton ? "command" : "click";
    clearButton.addEventListener(clearEvent, onClear, true);
    cleanup.push(() => quick.removeEventListener("input", onInput));
    cleanup.push(() => quick.removeEventListener("command", onCommand));
    cleanup.push(() => clearButton.removeEventListener(clearEvent, onClear, true));
    const view = itemsView();
    view?.onRefresh?.addListener?.(onRefresh);
    cleanup.push(() => view?.onRefresh?.removeListener?.(onRefresh));
    cleanup.push(() => {
      if (timer !== null) win.clearTimeout(timer);
      timer = null; serial++; closed = true;
      if (inline.refreshSearch === refreshSearch) delete inline.refreshSearch;
      if (ownClearButton && clearButton.id === "zcs-search-clear") clearButton.remove();
      inline.showOriginal();
    });
    // Handle a search field that was already populated before the plugin was
    // attached to the window.
    if (inputValue()) {
      schedule(0);
    }
    return cleanup;
  }

  removeFromWindow(win) {
    for (const close of this.windows.get(win) || []) close();
    this.windows.delete(win);
    this.inlineWindows.delete(win);
    this.favorites.removeFromWindow?.(win);
    win.document.querySelector('link[href="context-search.ftl"]')?.remove();
  }

  refreshFavorites() {
    if (this.destroyed) return;
    for (const inline of this.inlineWindows.values()) inline.refreshFavorites();
  }

  async selectItem(id, win = this.Zotero.getMainWindow()) {
    if (!win || win.closed || this.destroyed) return;
    const pane = win.ZoteroPane_Local || win.ZoteroPane;
    const view = pane?.itemsView;
    if (!view) return;
    const scope = () => (view.collectionTreeRows || [view.collectionTreeRow]).map(row => row?.id).join("|");
    const originalScope = scope();
    const stillCurrent = () => {
      const quick = win.document?.getElementById("zotero-tb-search");
      return !win.closed && !this.destroyed && pane.itemsView === view && scope() === originalScope
        && !String(quick?.searchTextbox?.value ?? quick?.value ?? "").trim();
    };
    await this.inlineWindows.get(win)?.clearSearch?.();
    await view.waitForLoad?.();
    if (!stillCurrent()) return;
    // Keep collection/tag scope intact, and align after Zotero finishes selection.
    await view.selectItems([id], true, true);
    if (!stillCurrent()) return;
    win.focus();
    view.tree?.focus?.();
    // Native tree.focus() queues its focus operation; let it run before alignment.
    await new Promise(resolve => win.setTimeout(resolve, 0));
    if (!stillCurrent() || !view.getSelectedItems(true).includes(id)) return;
    const row = view.getRowIndexByID(id);
    if (!Number.isInteger(row) || row < 0) return;
    const box = view._treebox || view.tree?._jsWindow;
    if (box?.scrollTo && box?._getItemPosition) {
      const tree = view.tree;
      const belowHeader = tree?.props?.stickySectionHeaders
        && !tree.props.isSectionHeader?.(row)
        && tree._getSectionHeaderIndices?.().some(index => index < row);
      const topOffset = belowHeader ? tree._rowHeight || 0 : 0;
      // Native row positions include custom heights. scrollTo keeps native end bounds.
      box.scrollTo(box._getItemPosition(row) - topOffset);
    }
    else view.ensureRowIsVisible?.(row);
  }

  async openAttachment(id, win = this.Zotero.getMainWindow(), pageNumber) {
    if (!win || win.closed) throw new Error(this.t("Zotero 기본 창을 연 뒤 다시 시도해 주세요.", "Open the Zotero library window and try again."));
    win.focus();
    // Zotero handles missing files, WebDAV downloads, and the user's reader preference.
    const pane = win.ZoteroPane_Local || win.ZoteroPane;
    if (Number.isSafeInteger(pageNumber) && pageNumber > 0) {
      await pane.viewAttachment(id, undefined, false, { location: { pageIndex: pageNumber - 1 } });
    }
    else await pane.viewAttachment(id);
  }

  async openResultFile(result, win = this.Zotero.getMainWindow()) {
    const attachmentID = result.snippets?.find(snippet => snippet.source === "pdf" && snippet.attachmentID)?.attachmentID
      || result.attachmentID;
    if (attachmentID) return this.openAttachment(attachmentID, win);
    const item = await this.Zotero.Items.getAsync(result.id);
    if (!item || item.deleted) throw new Error(this.t("이 문헌이 삭제되었거나 더 이상 존재하지 않습니다. 다시 검색해 주세요.", "This reference was deleted or is no longer available. Search again."));
    if (item.isAttachment?.()) return this.openAttachment(item.id, win);
    if (item.isRegularItem?.()) {
      const attachment = await item.getBestAttachment();
      if (attachment) return this.openAttachment(attachment.id, win);
    }
    // Records with no file still have a useful destination in the native list.
    return this.selectItem(result.id, win);
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.notifierID) this.Zotero.Notifier.unregisterObserver(this.notifierID);
    if (this.citationMenuID) this.Zotero.MenuManager.unregisterMenu(this.citationMenuID);
    if (this.Zotero.Prefs.get("search.quicksearch-mode") === "everything" && this.previousSearchMode) {
      this.Zotero.Prefs.set("search.quicksearch-mode", this.previousSearchMode);
    }
    for (const win of [...this.windows.keys()]) this.removeFromWindow(win);
    for (const win of this.Zotero.getMainWindows()) win.document.getElementById("zotero-tb-search")?.updateMode?.();
    await this.favorites.destroy();
    this.preferences.destroy();
    this.search.destroy?.();
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = ZCSController;
