/* global Zotero */
"use strict";

// Loaded by Zotero's script loader; exported for the small Node test suite too.
var ZCSFavorites = class ZCSFavorites {
  constructor({ Zotero, onChange = () => {}, log = () => {}, l10n }) {
    this.Zotero = Zotero;
    this.l10n = l10n || (typeof ZCSL10n !== "undefined" ? ZCSL10n : require("./localization.js")).create({ Zotero });
    this.onChange = onChange;
    this.log = log;
    this.columnKey = null;
    this._observerID = null;
    this._windows = new Map();
    this._pending = new Map();
    this._destroyed = false;
  }

  init() {
    if (this.columnKey || this._destroyed) return;
    const manager = this.Zotero.ItemTreeManager;
    const label = this.l10n.t("즐겨찾기", "Favorites");
    const options = {
      pluginID: "context-search@local.zotero",
      dataKey: "favorite",
      label,
      htmlLabel: `<span class="zcs-favorite-heading" title="${label}">★</span>`,
      enabledTreeIDs: ["main"],
      // Zotero 10 still uses defaultIn when deciding initial column visibility.
      // enabledTreeIDs alone registers the column but leaves it hidden on first install.
      defaultIn: ["default"],
      width: "36",
      minWidth: 36,
      flex: 0,
      fixedWidth: true,
      staticWidth: true,
      noPadding: true,
      sortReverse: true,
      showInColumnPicker: true,
      zoteroPersist: ["hidden", "ordinal", "sortDirection"],
      dataProvider: item => this.has(item) ? "1" : "0",
      renderCell: (index, data, column, isFirstColumn, doc) =>
        this._renderCell(index, data, column, doc),
    };
    this.columnKey = typeof manager.registerColumn === "function"
      ? manager.registerColumn(options)
      : manager.registerColumns([options])[0];
    if (!this.columnKey) throw new Error(this.l10n.t("즐겨찾기 열을 등록하지 못했습니다.", "The favorites column could not be registered."));
    try {
      this._observerID = this.Zotero.Notifier.registerObserver(
        this, ["item-tag", "item"], "context-search-favorites"
      );
    }
    catch (error) {
      this._unregisterColumn();
      throw error;
    }
  }

  has(item) {
    if (!item || typeof item.hasTag !== "function") return false;
    return item.hasTag("★");
  }

  canToggle(item) {
    if (this._destroyed || !item?.id || item.deleted || item.isFeedItem) return false;
    if (typeof item.isRegularItem !== "function" || !item.isRegularItem()) return false;
    if (typeof item.isEditable !== "function" || !item.isEditable()) return false;
    const library = this.Zotero.Libraries.get(item.libraryID);
    return !!library && library.editable !== false && library.libraryType !== "feed";
  }

  toggle(itemOrID) {
    const id = typeof itemOrID === "object" ? itemOrID?.id : itemOrID;
    if (!id || this._destroyed) return Promise.resolve(false);
    if (this._pending.has(id)) return this._pending.get(id);
    // Defer mutation until after the promise is in the map, including cached items.
    const task = Promise.resolve().then(async () => {
      const item = typeof itemOrID === "object"
        ? itemOrID : await this.Zotero.Items.getAsync(id);
      if (!this.canToggle(item)) return this.has(item);
      const oldTags = item.getTags().filter(entry => entry.tag === "★");
      const wasFavorite = this.has(item);
      if (wasFavorite) {
        item.removeTag("★");
      }
      else item.addTag("★", 0);
      try {
        await item.saveTx({
          skipSelect: true,
          undoAction: wasFavorite ? "undo-action-remove-tags-from-item" : "undo-action-add-tag",
          undoActionArgs: { count: wasFavorite ? oldTags.length : 1 },
        });
      }
      catch (error) {
        // A failed transaction must not leave an optimistic star in the item cache.
        if (item.hasTag("★")) item.removeTag("★");
        for (const entry of oldTags) item.addTag(entry.tag, entry.type);
        this._refreshWindows();
        throw error;
      }
      if (!this._destroyed) {
        this._refreshWindows();
        this._changed({ itemIDs: [id], source: "toggle" });
      }
      return this.has(item);
    });
    this._pending.set(id, task);
    const clear = () => { if (this._pending.get(id) === task) this._pending.delete(id); };
    task.then(clear, clear);
    return task;
  }

  addToWindow(win) {
    if (this._destroyed || this._windows.has(win)) return;
    const doc = win.document;
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = "zcs-favorites-style";
    style.textContent = `
      .zcs-favorite-heading { color: #ffcc00; font: 19px/1 sans-serif; text-shadow: 0 1px 1px #00000020; }
      .zcs-favorite-cell { display: flex; justify-content: center; padding: 0 !important; }
      .zcs-favorite-cell > .cell-text { display: flex; justify-content: center; width: 100%; }
      .zcs-favorite-cell > .item-icon { display: none; }
      .zcs-favorite-button {
        appearance: none; border: 0; border-radius: 4px; background: transparent;
        color: inherit; font: 23px/1 "Segoe UI Symbol", sans-serif;
        width: 30px; height: 100%; min-height: 22px; padding: 0;
        cursor: pointer; text-align: center; display: inline-flex;
        justify-content: center; align-items: center;
      }
      .zcs-favorite-button[aria-pressed="true"] {
        color: #ffcc00; text-shadow: 0 1px 1px #00000020;
      }
      .zcs-favorite-button:hover:not(:disabled) { background: rgba(128,128,128,.2); }
      .zcs-favorite-button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
      .zcs-favorite-button:disabled { cursor: default; opacity: .65; }
      [aria-selected="true"] .zcs-favorite-button[aria-pressed="true"],
      .selected .zcs-favorite-button[aria-pressed="true"] {
        color: #ffe34d; text-shadow: none;
      }
      @media (prefers-color-scheme: dark) {
        .zcs-favorite-heading, .zcs-favorite-button[aria-pressed="true"] {
          color: #ffd43b; text-shadow: none;
        }
      }
    `;
    doc.documentElement.appendChild(style);
    this._windows.set(win, { style, timer: null });
  }

  removeFromWindow(win) {
    const entry = this._windows.get(win);
    if (!entry) return;
    if (entry.timer !== null) win.clearTimeout(entry.timer);
    entry.style.remove();
    this._windows.delete(win);
  }

  _renderCell(index, data, column, doc) {
    const cell = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    // The first cell also contains Zotero's disclosure arrow. Marking the whole
    // cell "clickable" makes the native table swallow that arrow's mouse events.
    cell.className = `cell ${column.className || ""} zcs-favorite-cell`;
    const text = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    text.className = "cell-text";
    cell.appendChild(text);
    const item = doc.defaultView?.ZoteroPane?.itemsView?.getRow(index)?.ref;
    if (!item || !item.isRegularItem?.() || item.isFeedItem) return cell;
    const id = item.id;
    const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    button.type = "button";
    button.className = "zcs-favorite-button";
    button.dataset.itemId = String(id);
    const update = () => {
      const favorite = this.has(item);
      button.textContent = favorite ? "★" : "☆";
      button.setAttribute("aria-pressed", String(favorite));
      button.disabled = !this.canToggle(item);
      const label = button.disabled ? this.l10n.t("즐겨찾기 (읽기 전용)", "Favorite (read-only)")
        : favorite ? this.l10n.t("즐겨찾기 해제", "Remove from favorites") : this.l10n.t("즐겨찾기 추가", "Add to favorites");
      button.title = label;
      button.setAttribute("aria-label", label);
    };
    update();
    text.appendChild(button);
    const onButton = event => event.target === button
      || event.composedPath?.().includes(button)
      || (event.target && button.contains?.(event.target));
    const stop = event => { event.stopPropagation(); event.preventDefault(); };
    // Intercept only the star, including any child icon, so the native disclosure
    // arrow, blank cell space, and ordinary row navigation keep their own behavior.
    for (const name of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu", "dragstart"]) {
      cell.addEventListener(name, event => { if (onButton(event)) stop(event); });
    }
    cell.addEventListener("keydown", event => {
      if (!onButton(event) || (event.key !== " " && event.key !== "Enter")) return;
      stop(event);
      if (!event.repeat && !button.disabled) button.click();
    });
    cell.addEventListener("keyup", event => {
      if (onButton(event) && (event.key === " " || event.key === "Enter")) stop(event);
    });
    cell.addEventListener("click", event => {
      if (!onButton(event)) return;
      stop(event);
      if (button.disabled || event.button > 0 || event.detail > 1) return;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      this.toggle(id).catch(error => {
        this._report(error);
        doc.defaultView?.alert?.(this.l10n.t("즐겨찾기를 저장하지 못했습니다.\n{error}", "The favorite could not be saved.\n{error}", { error: error.message || error }));
      }).finally(() => {
        button.removeAttribute("aria-busy");
        update();
      });
    });
    return cell;
  }

  notify(action, type, ids) {
    if (this._destroyed || !["item-tag", "item"].includes(type)) return;
    const itemIDs = [...new Set(ids.map(id => Number(type === "item-tag" ? String(id).split("-")[0] : id)).filter(Number.isFinite))];
    this._refreshWindows();
    this._changed({ itemIDs, source: "notifier" });
  }

  _refreshWindows() {
    if (this._destroyed) return;
    for (const [win, entry] of this._windows) {
      if (entry.timer !== null || win.closed) continue;
      entry.timer = win.setTimeout(async () => {
        entry.timer = null;
        if (this._destroyed || !this._windows.has(win) || win.closed) return;
        try {
          const view = win.ZoteroPane?.itemsView;
          if (view?.getColumns?.().some(column => column.dataKey === this.columnKey && column.sortDirection)) {
            await view.sort();
          }
          view?.tree?.invalidate();
        }
        catch (error) { this._report(error); }
      }, 50);
    }
  }

  _changed(event) {
    try { Promise.resolve(this.onChange(event)).catch(error => this._report(error)); }
    catch (error) { this._report(error); }
  }

  _report(error) {
    this.log(error);
    this.Zotero.logError?.(error);
  }

  _unregisterColumn() {
    if (!this.columnKey) return;
    const manager = this.Zotero.ItemTreeManager;
    if (typeof manager.unregisterColumn === "function") manager.unregisterColumn(this.columnKey);
    else manager.unregisterColumns([this.columnKey]);
    this.columnKey = null;
  }

  async destroy() {
    this._destroyed = true;
    if (this._observerID !== null) {
      this.Zotero.Notifier.unregisterObserver(this._observerID);
      this._observerID = null;
    }
    this._unregisterColumn();
    for (const win of this._windows.keys()) this.removeFromWindow(win);
    await Promise.allSettled(this._pending.values());
  }
};

if (typeof module !== "undefined") module.exports = ZCSFavorites;
