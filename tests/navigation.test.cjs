const test = require('node:test');
const assert = require('node:assert/strict');
const Controller = require('../addon/content/controller.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ items = new Map(), mainWindow } = {}) {
  const events = [];
  const quick = { searchTextbox: { value: 'sample phrase' } };
  let selected = [];
  const box = {
    _getItemPosition(row) { events.push(['position', row]); return 240; },
    scrollTo(position) { events.push(['scroll', position]); this.scrollTop = Math.min(180, Math.max(0, position)); },
  };
  const view = {
    collectionTreeRow: { id: 'C1' },
    async waitForLoad() { events.push(['load']); },
    async selectItems(ids, noRecurse, noScroll) {
      events.push(['select', ids, noRecurse, noScroll]);
      selected = ids;
    },
    getSelectedItems(asIDs) { assert.equal(asIDs, true); return selected; },
    getRowIndexByID(id) { events.push(['row', id]); return selected.includes(id) ? 7 : -1; },
    tree: { focus() { events.push(['tree-focus']); } },
    _treebox: box,
  };
  const pane = {
    itemsView: view,
    async viewAttachment(id) { events.push(['open', id]); },
  };
  const win = {
    ZoteroPane: pane,
    document: { getElementById(id) { return id === 'zotero-tb-search' ? quick : null; } },
    focus() { events.push(['window-focus']); },
    setTimeout(callback, delay) { events.push(['timer', delay]); return setTimeout(callback, delay); },
  };
  const inline = {
    get query() { return quick.searchTextbox.value; },
    set query(value) { quick.searchTextbox.value = value; },
    async clearSearch() { events.push(['clear']); this.query = ''; },
  };
  const controller = Object.assign(Object.create(Controller.prototype), {
    destroyed: false,
    inlineWindows: new Map([[win, inline]]),
    Zotero: {
      locale: 'ko-KR',
      getMainWindow() { return mainWindow === undefined ? win : mainWindow; },
      Items: { async getAsync(id) { events.push(['item', id]); return items.get(id); } },
    },
  });
  return { controller, win, pane, view, box, inline, quick, events, setSelected(ids) { selected = ids; } };
}

test('result opening chooses the first matched PDF, not another parent attachment', async () => {
  const { controller, win, events, inline } = fixture();
  await controller.openResultFile({
    id: 1, attachmentID: 10,
    snippets: [
      { source: 'note', attachmentID: 11 },
      { source: 'pdf' },
      { source: 'pdf', attachmentID: 23 },
      { source: 'pdf', attachmentID: 24 },
    ],
  }, win);
  assert.deepEqual(events, [['window-focus'], ['open', 23]]);
  assert.equal(inline.query, 'sample phrase');
});

test('result attachment is used when no snippet identifies a matching PDF', async () => {
  const { controller, win, events } = fixture();
  await controller.openResultFile({ id: 1, attachmentID: 10, snippets: [{ source: 'metadata' }] }, win);
  assert.deepEqual(events, [['window-focus'], ['open', 10]]);
});

test('direct attachments and a regular item best attachment can open non-PDF files', async () => {
  let bestCalls = 0;
  const items = new Map([
    [12, { id: 12, isAttachment: () => true, attachmentContentType: 'text/plain' }],
    [1, {
      id: 1, isRegularItem: () => true,
      async getBestAttachment() { bestCalls++; return { id: 13, attachmentContentType: 'image/png' }; },
    }],
  ]);
  const { controller, win, events, inline } = fixture({ items });
  await controller.openResultFile({ id: 12 }, win);
  await controller.openResultFile({ id: 1 }, win);
  assert.deepEqual(events.filter(event => event[0] === 'open'), [['open', 12], ['open', 13]]);
  assert.equal(bestCalls, 1);
  assert.equal(inline.query, 'sample phrase');
});

test('a bibliographic item without a file falls back to native list selection', async () => {
  const item = { id: 1, isRegularItem: () => true, async getBestAttachment() { return false; } };
  const { controller, win, events } = fixture({ items: new Map([[1, item]]) });
  const selections = [];
  controller.selectItem = async (...args) => { selections.push(args); };
  await controller.openResultFile({ id: 1 }, win);
  assert.deepEqual(selections, [[1, win]]);
  assert.equal(events.some(event => event[0] === 'open'), false);
});

test('missing and deleted result items reject without opening or navigating elsewhere', async () => {
  const { controller, win, events } = fixture({ items: new Map([[2, { id: 2, deleted: true }]]) });
  await assert.rejects(controller.openResultFile({ id: 1 }, win), /삭제|존재/);
  await assert.rejects(controller.openResultFile({ id: 2 }, win), /삭제|존재/);
  assert.deepEqual(events, [['item', 1], ['item', 2]]);
});

test('attachment opening uses its originating native pane and keeps the query', async () => {
  const { controller, win, inline, events } = fixture({ mainWindow: { focus() { throw new Error('Wrong window'); } } });
  win.ZoteroPane_Local = { async viewAttachment(id) { events.push(['origin-open', id]); } };
  await controller.openAttachment(42, win);
  assert.deepEqual(events, [['window-focus'], ['origin-open', 42]]);
  assert.equal(inline.query, 'sample phrase');
});

test('attachment opening falls back to the main window and rejects unavailable windows', async () => {
  const { controller, win, events } = fixture();
  await controller.openAttachment(42);
  assert.deepEqual(events, [['window-focus'], ['open', 42]]);
  win.closed = true;
  await assert.rejects(controller.openAttachment(42), /창/);
  const absent = fixture({ mainWindow: null });
  await assert.rejects(absent.controller.openAttachment(42), /창/);
  assert.deepEqual(absent.events, []);
});

test('page navigation converts physical PDF pages to native zero-based locations', async () => {
  const { controller, win, pane, inline } = fixture();
  const calls = [];
  pane.viewAttachment = async (...args) => calls.push(args);
  await controller.openAttachment(42, win, 1);
  await controller.openAttachment(43, win, 17);
  assert.deepEqual(calls, [
    [42, undefined, false, { location: { pageIndex: 0 } }],
    [43, undefined, false, { location: { pageIndex: 16 } }],
  ]);
  assert.equal(inline.query, 'sample phrase');
});

test('invalid or unknown page numbers use native default opening', async () => {
  const { controller, win, pane } = fixture();
  const calls = [];
  pane.viewAttachment = async (...args) => calls.push(args);
  const invalid = [undefined, null, 0, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalid) await controller.openAttachment(42, win, value);
  assert.deepEqual(calls, invalid.map(() => [42]));
});

test('native attachment errors reach the caller without clearing the query or falling back', async () => {
  const { controller, pane, win, events, inline } = fixture();
  const failure = new Error('Native file open failed');
  pane.viewAttachment = async () => { throw failure; };
  await assert.rejects(controller.openResultFile({ id: 1, attachmentID: 42 }, win), error => error === failure);
  assert.equal(inline.query, 'sample phrase');
  assert.deepEqual(events, [['window-focus']]);
});

test('list navigation waits for restored rows and selection before aligning the selected row', async () => {
  const { controller, win, view, box, inline, events, setSelected } = fixture();
  const clearDone = deferred(), loadStarted = deferred(), loadDone = deferred();
  const selectStarted = deferred(), selectDone = deferred(), timerStarted = deferred();
  let finishFocusTurn;
  inline.clearSearch = async () => {
    events.push(['clear-start']);
    await clearDone.promise;
    inline.query = '';
    events.push(['clear-done']);
  };
  view.waitForLoad = async () => {
    events.push(['load-start']); loadStarted.resolve();
    await loadDone.promise;
    events.push(['load-done']);
  };
  view.selectItems = async (...args) => {
    events.push(['select-start', ...args]); selectStarted.resolve();
    await selectDone.promise;
    setSelected(args[0]);
    events.push(['select-done']);
  };
  win.setTimeout = (callback, delay) => {
    assert.equal(delay, 0);
    finishFocusTurn = callback;
    events.push(['timer', delay]);
    timerStarted.resolve();
  };

  const navigation = controller.selectItem(77, win);
  assert.deepEqual(events, [['clear-start']]);
  clearDone.resolve(); await loadStarted.promise;
  assert.equal(events.some(event => event[0] === 'select-start'), false);
  loadDone.resolve(); await selectStarted.promise;
  assert.deepEqual(events.at(-1), ['select-start', [77], true, true]);
  assert.equal(events.some(event => event[0] === 'row'), false);
  selectDone.resolve(); await timerStarted.promise;
  assert.equal(events.some(event => event[0] === 'row'), false);
  finishFocusTurn(); await navigation;

  assert.equal(inline.query, '');
  assert.deepEqual(events.map(event => event[0]), [
    'clear-start', 'clear-done', 'load-start', 'load-done', 'select-start', 'select-done',
    'window-focus', 'tree-focus', 'timer', 'row', 'position', 'scroll',
  ]);
  assert.deepEqual(events.at(-1), ['scroll', 240]);
  assert.equal(box.scrollTop, 180, 'The native box applies its own end-of-list bound');
});

test('list navigation does not scroll an obsolete native view after asynchronous selection', async () => {
  const { controller, pane, win, view, events } = fixture();
  view.selectItems = async () => { pane.itemsView = {}; };
  await controller.selectItem(1, win);
  assert.deepEqual(events, [['clear'], ['load']]);
});

test('list navigation does not override a newer selection made before alignment', async () => {
  const { controller, win, events, setSelected } = fixture();
  win.setTimeout = callback => { setSelected([2]); queueMicrotask(callback); };
  await controller.selectItem(1, win);
  assert.equal(events.some(event => ['row', 'position', 'scroll'].includes(event[0])), false);
});

test('list navigation handles absent rows and falls back to native visibility when needed', async () => {
  const missing = fixture();
  missing.view.getRowIndexByID = () => -1;
  await missing.controller.selectItem(1, missing.win);
  assert.equal(missing.events.some(event => event[0] === 'scroll'), false);

  const fallback = fixture();
  delete fallback.view._treebox;
  fallback.view.ensureRowIsVisible = row => fallback.events.push(['ensure-visible', row]);
  await fallback.controller.selectItem(1, fallback.win);
  assert.deepEqual(fallback.events.at(-1), ['ensure-visible', 7]);
});

test('list navigation leaves space for an active sticky section header', async () => {
  const cases = [
    { sticky: true, headerRow: false, headers: [0, 4], target: 208 },
    { sticky: true, headerRow: true, headers: [0, 7], target: 240 },
    { sticky: true, headerRow: false, headers: [9], target: 240 },
    { sticky: false, headerRow: false, headers: [0], target: 240 },
  ];
  for (const scenario of cases) {
    const { controller, win, view, events } = fixture();
    Object.assign(view.tree, {
      props: { stickySectionHeaders: scenario.sticky, isSectionHeader: () => scenario.headerRow },
      _getSectionHeaderIndices: () => scenario.headers,
      _rowHeight: 32,
    });
    await controller.selectItem(1, win);
    assert.deepEqual(events.at(-1), ['scroll', scenario.target], JSON.stringify(scenario));
  }
});

test('list navigation stops when collection scope changes within the same view', async () => {
  const loading = fixture();
  loading.view.waitForLoad = async () => { loading.view.collectionTreeRow = { id: 'C2' }; };
  await loading.controller.selectItem(1, loading.win);
  assert.equal(loading.pane.itemsView, loading.view);
  assert.equal(loading.events.some(event => ['select', 'row', 'scroll'].includes(event[0])), false);

  const aligning = fixture();
  aligning.view.collectionTreeRows = [{ id: 'L1' }, { id: 'C1' }];
  aligning.win.setTimeout = callback => {
    aligning.view.collectionTreeRows = [{ id: 'L1' }, { id: 'C2' }];
    queueMicrotask(callback);
  };
  await aligning.controller.selectItem(1, aligning.win);
  assert.equal(aligning.pane.itemsView, aligning.view);
  assert.equal(aligning.events.some(event => event[0] === 'select'), true);
  assert.equal(aligning.events.some(event => ['row', 'position', 'scroll'].includes(event[0])), false);
});

test('a new query prevents pending list selection or alignment without clearing the new text', async () => {
  const loading = fixture();
  loading.view.waitForLoad = async () => { loading.quick.searchTextbox.value = 'new query'; };
  await loading.controller.selectItem(1, loading.win);
  assert.equal(loading.events.some(event => event[0] === 'select'), false);
  assert.equal(loading.quick.searchTextbox.value, 'new query');

  const aligning = fixture();
  aligning.win.setTimeout = callback => {
    aligning.quick.searchTextbox.value = 'another query';
    queueMicrotask(callback);
  };
  await aligning.controller.selectItem(1, aligning.win);
  assert.equal(aligning.events.some(event => event[0] === 'select'), true);
  assert.equal(aligning.events.some(event => ['row', 'position', 'scroll'].includes(event[0])), false);
  assert.equal(aligning.quick.searchTextbox.value, 'another query');
});

test('native queued tree focus completes before row alignment', async () => {
  const { controller, win, view, box, events } = fixture();
  let focused = false;
  view.tree.focus = () => {
    win.setTimeout(() => { focused = true; events.push(['native-focus-done']); }, 0);
  };
  box.scrollTo = position => {
    assert.equal(focused, true);
    events.push(['scroll', position]);
  };
  await controller.selectItem(1, win);
  assert.ok(events.findIndex(event => event[0] === 'native-focus-done')
    < events.findIndex(event => event[0] === 'row'));
  assert.deepEqual(events.at(-1), ['scroll', 240]);
});
