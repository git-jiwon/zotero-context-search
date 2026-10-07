const test = require("node:test");
const assert = require("node:assert/strict");
const Favorites = require("../addon/content/favorites.js");

function fixture({ locale = 'ko-KR' } = {}) {
  const calls = { registered: [], unregistered: [], observers: [], removedObservers: [], changes: [] };
  const items = new Map();
  const Zotero = {
    locale,
    Libraries: { get: () => ({ editable: true, libraryType: "user" }) },
    Items: { getAsync: async id => items.get(id) },
    ItemTreeManager: {
      registerColumn: options => { calls.registered.push(options); return "context-search-local-zotero-favorite"; },
      unregisterColumn: key => calls.unregistered.push(key),
    },
    Notifier: {
      registerObserver: (...args) => { calls.observers.push(args); return 7; },
      unregisterObserver: id => calls.removedObservers.push(id),
    },
    logError: () => {},
  };
  const favorites = new Favorites({ Zotero, onChange: event => calls.changes.push(event) });
  function item(tags = [], overrides = {}) {
    const entry = {
      id: items.size + 1, libraryID: 1, title: "Original title", saves: [],
      tags: tags.map(tag => typeof tag === "string" ? { tag, type: 0 } : { ...tag }),
      isRegularItem: () => true, isEditable: () => true,
      hasTag(tag) { return this.tags.some(entry => entry.tag === tag); },
      getTags() { return this.tags.map(entry => ({ ...entry })); },
      addTag(tag, type = 0) { if (!this.hasTag(tag)) this.tags.push({ tag, type }); },
      removeTag(tag) { this.tags = this.tags.filter(entry => entry.tag !== tag); },
      async saveTx(options) { this.saves.push(options); },
      ...overrides,
    };
    items.set(entry.id, entry);
    return entry;
  }
  return { Zotero, favorites, calls, item };
}

test("recognizes only the user's existing black-star tag without migrating anything", () => {
  const { favorites, item } = fixture();
  for (const tag of ["★"]) {
    const entry = item([tag, "research"]);
    assert.equal(favorites.has(entry), true);
    assert.deepEqual(entry.tags.map(t => t.tag), [tag, "research"]);
    assert.equal(entry.saves.length, 0);
  }
  assert.equal(favorites.has(item(["⭐important"])), false);
  assert.equal(favorites.has(item(["⭐"])), false);
  assert.equal(favorites.has(null), false);
});

test("adds only the existing black-star tag, preserves title and other tags, supports native Undo", async () => {
  const { favorites, item } = fixture();
  const entry = item([{ tag: "research", type: 1 }]);
  assert.equal(await favorites.toggle(entry.id), true);
  assert.deepEqual(entry.tags, [{ tag: "research", type: 1 }, { tag: "★", type: 0 }]);
  assert.equal(entry.title, "Original title");
  assert.deepEqual(entry.saves, [{ skipSelect: true, undoAction: "undo-action-add-tag", undoActionArgs: { count: 1 } }]);
});

test("explicitly unstar removes only black star and preserves the unrelated emoji star", async () => {
  const { favorites, item } = fixture();
  const entry = item(["⭐", "★", "important"]);
  assert.equal(await favorites.toggle(entry), false);
  assert.deepEqual(entry.tags.map(t => t.tag), ["⭐", "important"]);
  assert.equal(entry.saves[0].undoAction, "undo-action-remove-tags-from-item");
  assert.equal(entry.saves[0].undoActionArgs.count, 1);
});

test("read-only, feed, trash, attachment and missing items cannot be changed", async () => {
  const { favorites, item, Zotero } = fixture();
  const blocked = [
    item(["★"], { isEditable: () => false }), item([], { isFeedItem: true }),
    item([], { deleted: true }), item([], { isRegularItem: () => false }),
  ];
  for (const entry of blocked) {
    const before = entry.getTags();
    await favorites.toggle(entry);
    assert.deepEqual(entry.tags, before);
    assert.equal(entry.saves.length, 0);
  }
  assert.equal(await favorites.toggle(999), false);
  Zotero.Libraries.get = () => ({ editable: false, libraryType: "group" });
  const groupItem = item();
  await favorites.toggle(groupItem);
  assert.equal(groupItem.saves.length, 0);
});

test("concurrent clicks share one write and a later deliberate click toggles again", async () => {
  const { favorites, item } = fixture();
  let finish;
  const barrier = new Promise(resolve => { finish = resolve; });
  const entry = item([], { async saveTx(options) { this.saves.push(options); await barrier; } });
  const first = favorites.toggle(entry);
  const second = favorites.toggle(entry.id);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(entry.saves.length, 1);
  finish();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(await favorites.toggle(entry), false);
  assert.equal(entry.saves.length, 2);
});

test("failed save restores the black star's original type and leaves emoji star alone", async () => {
  const { favorites, item, calls } = fixture();
  const entry = item([{ tag: "★", type: 1 }, { tag: "⭐", type: 0 }, "research"], {
    async saveTx() { throw new Error("disk unavailable"); },
  });
  await assert.rejects(favorites.toggle(entry), /disk unavailable/);
  assert.deepEqual(entry.tags, [{ tag: "⭐", type: 0 }, { tag: "research", type: 0 }, { tag: "★", type: 1 }]);
  assert.equal(calls.changes.length, 0);
});

test("registers sortable main-library column and cleans up actual namespaced key once", async () => {
  const { favorites, item, calls } = fixture();
  favorites.init();
  favorites.init();
  assert.equal(calls.registered.length, 1);
  const column = calls.registered[0];
  assert.deepEqual(column.enabledTreeIDs, ["main"]);
  assert.deepEqual(column.defaultIn, ["default"]);
  assert.equal(column.pluginID, "context-search@local.zotero");
  assert.equal(column.dataProvider(item(["★"])), "1");
  assert.equal(column.dataProvider(item()), "0");
  await favorites.destroy();
  await favorites.destroy();
  assert.deepEqual(calls.unregistered, ["context-search-local-zotero-favorite"]);
  assert.deepEqual(calls.removedObservers, [7]);
  assert.equal(await favorites.toggle(item()), false);
});

function documentMock() {
  const document = {
    createElementNS(namespace, name) {
      const listeners = new Map();
      const attrs = new Map();
      return {
        localName: name, children: [], dataset: {}, disabled: false,
        appendChild(node) { this.children.push(node); node.parentNode = this; return node; },
        contains(node) { return this === node || this.children.some(child => child.contains(node)); },
        setAttribute(key, value) { attrs.set(key, value); },
        getAttribute(key) { return attrs.get(key); },
        removeAttribute(key) { attrs.delete(key); },
        addEventListener(name, listener) { listeners.set(name, listener); },
        remove() { this.removed = true; },
        click() { return this.dispatch("click", { detail: 0 }); },
        dispatch(name, args = {}) {
          const event = {
            key: "", button: 0, detail: 1, stopped: false, prevented: false, target: this,
            stopPropagation() { this.stopped = true; },
            preventDefault() { this.prevented = true; },
            ...args,
          };
          listeners.get(name)?.(event);
          if (!event.stopped && this.parentNode) this.parentNode.bubble(name, event);
          return event;
        },
        bubble(name, event) {
          listeners.get(name)?.(event);
          if (!event.stopped && this.parentNode) this.parentNode.bubble(name, event);
        },
      };
    },
  };
  document.documentElement = document.createElementNS("", "html");
  return document;
}

test("cell keeps its rendered item identity and stops selection/opening events", async () => {
  const { favorites, item, calls } = fixture();
  favorites.init();
  const original = item();
  const other = item();
  let rowItem = original;
  const doc = documentMock();
  doc.defaultView = { ZoteroPane: { itemsView: { getRow: () => ({ ref: rowItem }) } } };
  const cell = calls.registered[0].renderCell(3, "0", { className: "column" }, false, doc);
  const button = cell.children[0].children[0];
  assert.doesNotMatch(cell.className, /\bclickable\b/);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"]) {
    const event = button.dispatch(type);
    assert.equal(event.stopped, true);
    assert.equal(event.prevented, true);
  }
  rowItem = other;
  const click = button.dispatch("click");
  assert.equal(click.stopped, true);
  await favorites._pending.get(original.id);
  assert.equal(favorites.has(original), true);
  assert.equal(favorites.has(other), false);
  await Promise.resolve();
  await Promise.resolve();
  button.dispatch("click", { detail: 2 });
  assert.equal(original.saves.length, 1);
  await favorites.destroy();
});

test("first-column disclosure arrow and blank cell events never change favorites or get intercepted", async () => {
  const { favorites, item, calls } = fixture();
  favorites.init();
  const entry = item();
  const doc = documentMock();
  doc.defaultView = { ZoteroPane: { itemsView: { getRow: () => ({ ref: entry }) } } };
  const cell = calls.registered[0].renderCell(0, "0", { className: "column" }, true, doc);
  const twisty = doc.createElementNS("", "span");
  twisty.className = "twisty";
  cell.appendChild(twisty);
  assert.doesNotMatch(cell.className, /\bclickable\b/, "native capture must allow arrow mouseup to reach its target");
  for (const target of [twisty, cell, cell.children[0]]) {
    for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup", "click", "dblclick", "contextmenu", "dragstart"]) {
      const event = target.dispatch(type);
      assert.equal(event.stopped, false, `${type} remains available to Zotero`);
      assert.equal(event.prevented, false, `${type} keeps its native default`);
    }
  }
  let expanded = false;
  twisty.addEventListener("mouseup", () => { expanded = !expanded; });
  twisty.dispatch("mouseup");
  twisty.dispatch("click");
  assert.equal(expanded, true);
  assert.equal(favorites._pending.size, 0);
  assert.equal(entry.saves.length, 0);
  assert.equal(favorites.has(entry), false);
  await favorites.destroy();
});

test("row keyboard navigation passes through while Enter and Space activate only a focused star", async () => {
  const { favorites, item, calls } = fixture();
  favorites.init();
  const entry = item();
  const doc = documentMock();
  doc.defaultView = { ZoteroPane: { itemsView: { getRow: () => ({ ref: entry }) } } };
  const cell = calls.registered[0].renderCell(0, "0", {}, true, doc);
  const button = cell.children[0].children[0];
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Enter", " "]) {
    for (const type of ["keydown", "keyup"]) {
      const event = cell.dispatch(type, { key });
      assert.equal(event.stopped, false);
      assert.equal(event.prevented, false);
    }
  }
  const arrowOnStar = button.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(arrowOnStar.stopped, false);
  assert.equal(arrowOnStar.prevented, false);
  for (const key of ["Enter", " "]) {
    const down = button.dispatch("keydown", { key });
    assert.equal(down.stopped, true);
    assert.equal(down.prevented, true);
    await favorites._pending.get(entry.id);
    await Promise.resolve();
    await Promise.resolve();
    const saves = entry.saves.length;
    button.dispatch("keydown", { key, repeat: true });
    const up = button.dispatch("keyup", { key });
    assert.equal(up.stopped, true);
    assert.equal(up.prevented, true, "native Space release must not create a second click");
    assert.equal(entry.saves.length, saves);
  }
  assert.equal(entry.saves.length, 2);
  assert.equal(favorites.has(entry), false);
  await favorites.destroy();
});

test("nested star artwork and composed event paths still activate the intended favorite", async () => {
  const { favorites, item, calls } = fixture();
  favorites.init();
  const entry = item();
  const doc = documentMock();
  doc.defaultView = { ZoteroPane: { itemsView: { getRow: () => ({ ref: entry }) } } };
  const cell = calls.registered[0].renderCell(0, "0", {}, false, doc);
  const button = cell.children[0].children[0];
  const artwork = doc.createElementNS("", "span");
  button.appendChild(artwork);
  const event = artwork.dispatch("click");
  assert.equal(event.stopped, true);
  assert.equal(event.prevented, true);
  await favorites._pending.get(entry.id);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(favorites.has(entry), true);
  const retargeted = cell.dispatch("click", { composedPath: () => [artwork, button, cell] });
  assert.equal(retargeted.stopped, true);
  await favorites._pending.get(entry.id);
  assert.equal(favorites.has(entry), false);
  assert.equal(entry.saves.length, 2);
  await favorites.destroy();
});

test("styles, notifier refresh timers and observer are removed on shutdown", async () => {
  const { favorites, calls } = fixture();
  const doc = documentMock();
  const timers = new Map();
  const win = {
    document: doc, closed: false,
    setTimeout: callback => { timers.set(42, callback); return 42; },
    clearTimeout: id => timers.delete(id),
  };
  favorites.init();
  favorites.addToWindow(win);
  favorites.addToWindow(win);
  assert.equal(doc.documentElement.children.length, 1);
  favorites.notify("add", "item-tag", ["23-98", "23-100", "25-101"]);
  assert.deepEqual(calls.changes[0].itemIDs, [23, 25]);
  assert.equal(timers.size, 1);
  await favorites.destroy();
  assert.equal(timers.size, 0);
  assert.equal(doc.documentElement.children[0].removed, true);
  const count = calls.changes.length;
  favorites.notify("modify", "item", [23]);
  assert.equal(calls.changes.length, count);
});

test("English favorite headers and accessible tooltips reflect state without changing the star tag", async () => {
  const { favorites, item, calls } = fixture({ locale: 'en-US' });
  favorites.init();
  const column = calls.registered[0];
  assert.equal(column.label, 'Favorites');
  assert.match(column.htmlLabel, /title="Favorites"/);
  const cases = [
    [item(), 'Add to favorites', '☆'],
    [item(['★']), 'Remove from favorites', '★'],
    [item(['★'], { isEditable: () => false }), 'Favorite (read-only)', '★'],
  ];
  for (const [entry, label, glyph] of cases) {
    const doc = documentMock();
    doc.defaultView = { ZoteroPane: { itemsView: { getRow: () => ({ ref: entry }) } } };
    const button = column.renderCell(0, '0', {}, false, doc).children[0].children[0];
    assert.equal(button.title, label);
    assert.equal(button.getAttribute('aria-label'), label);
    assert.equal(button.textContent, glyph);
    assert.equal(entry.saves.length, 0);
  }
  await favorites.destroy();
});

test("English favorite failures localize the alert while retaining the original error detail", async () => {
  const { favorites, item, calls } = fixture({ locale: 'en-US' });
  favorites.init();
  const entry = item([], { async saveTx() { throw new Error('Storage unavailable'); } });
  let alertMessage, alertDone;
  const alerted = new Promise(resolve => { alertDone = resolve; });
  const doc = documentMock();
  doc.defaultView = {
    ZoteroPane: { itemsView: { getRow: () => ({ ref: entry }) } },
    alert(message) { alertMessage = message; alertDone(); },
  };
  const button = calls.registered[0].renderCell(0, '0', {}, false, doc).children[0].children[0];
  button.dispatch('click');
  await alerted;
  assert.equal(alertMessage, 'The favorite could not be saved.\nStorage unavailable');
  assert.equal(favorites.has(entry), false);
  await favorites.destroy();

  const rejected = fixture({ locale: 'en-US' });
  rejected.Zotero.ItemTreeManager.registerColumn = () => null;
  assert.throws(() => rejected.favorites.init(), /favorites column could not be registered/);
});
