const test = require('node:test');
const assert = require('node:assert/strict');
const Search = require('../addon/content/search.js');
const core = require('../addon/content/snippets.js');
const Controller = require('../addon/content/controller.js');

function fixture({ ids = [1], text = {}, documents = [], onRead, onYield, locale = 'ko-KR' } = {}) {
  const searches = [], reads = [], gets = [];
  const makeItem = (data) => ({
    id: data.id, parentItemID: data.parentItemID, libraryID: data.libraryID || 1, deleted: !!data.deleted,
    dateAdded: data.dateAdded, dateModified: '2026-10-03 00:00:00', attachmentContentType: data.pdf ? 'application/pdf' : '',
    async loadDataType() {},
    getField(name) { return (data.fields || {})[name] || ''; },
    getTags() { return (data.tags || []).map(tag => ({ tag })); },
    getCreators() { return data.creators || []; },
    getAttachments() { return data.attachments || []; },
    getNotes() { return data.notes || []; },
    getNote() { return data.note || ''; },
    isAttachment() { return !!data.pdf; }, isNote() { return data.note !== undefined; },
    isRegularItem() { return !data.pdf && data.note === undefined; },
    isEditable() { return data.editable !== false; },
  });
  const items = new Map(documents.map(data => [data.id, makeItem(data)]));
  const Zotero = {
    locale,
    Search: class {
      constructor() { this.conditions = []; searches.push(this); }
      addCondition(...args) { this.conditions.push(args); }
      async search() { return ids; }
    },
    Libraries: { userLibraryID: 1, get(id) { return id === 1 ? { editable: true } : null; } },
    Items: { get(id) { return items.get(id); }, async getAsync(requested) { gets.push([...requested]); return requested.map(id => items.get(id)); } },
    Fulltext: { getItemCacheFile(item) { return { path: '/cache/' + item.id }; } },
    File: { async getContentsAsync(path) { reads.push(path); if (onRead) onRead(path); if (!(path in text)) throw new Error('No cache'); return text[path]; } },
    Promise: { async delay() { if (onYield) onYield(); } },
  };
  return { engine: new Search({ Zotero, core }), Zotero, searches, reads, gets, items };
}

function nativePhraseFixture(data, { hits = {}, onSearch, fail = false } = {}) {
  const output = fixture(data);
  const { Zotero } = output;
  const tables = new Map(), scopes = [], drops = [], errors = [];
  Zotero.Search.idsToTempTable = async (ids, options) => {
    assert.equal(options.idColumn, 'id');
    const table = 'tmpSearchResults_fixture' + tables.size;
    tables.set(table, [...ids]);
    return table;
  };
  Zotero.Search.prototype.setScope = function (scope, includeChildren) {
    this.scope = scope; this.includeChildren = includeChildren;
  };
  Zotero.Search.prototype.search = async function () {
    assert.equal(this.includeChildren, true);
    const condition = this.scope.conditions.find(c => c[0] === 'tempTable');
    scopes.push({ libraryID: this.libraryID, ids: tables.get(condition[2]), conditions: this.conditions });
    if (onSearch) onSearch(this);
    if (fail) throw new Error('Native phrase lookup failed');
    return hits[this.libraryID] || [];
  };
  Zotero.DB = { async queryAsync(sql) { drops.push(sql); } };
  Zotero.logError = error => errors.push(error);
  return { ...output, tables, scopes, drops, errors };
}

test('date sorting uses parent dateAdded, stable native ties and missing dates last in both directions', async () => {
  const { engine, items, reads, searches } = fixture({ documents: [
    { id: 1, dateAdded: '2024-01-01 00:00:00', fields: { date: '2099' } },
    { id: 2, dateAdded: '2026-01-01 00:00:00', fields: { date: '1900' } },
    { id: 3, dateAdded: '2026-01-01T09:00:00+09:00', libraryID: 2 },
    { id: 4 }, { id: 5, dateAdded: 'invalid' }, { id: 6, dateAdded: '2026-02-30' },
    { id: 12, parentItemID: 1, pdf: true, dateAdded: '2099-01-01 00:00:00' },
  ] });
  const candidates = [4, 12, 3, 2, 1, 5, 6].map(id => items.get(id));
  const newest = await engine.sortNativeResults({ query: 'stored charge', items: candidates, sortMode: 'dateAddedDesc' });
  const oldest = await engine.sortNativeResults({ query: 'stored charge', items: candidates, sortMode: 'dateAddedAsc' });
  assert.deepEqual(newest.map(item => item.id), [3, 2, 1, 4, 5, 6]);
  assert.deepEqual(oldest.map(item => item.id), [1, 3, 2, 4, 5, 6]);
  assert.deepEqual(reads, []); assert.equal(searches.length, 0);
});

test('date ordering covers the entire candidate set before pagination and keeps cancellation', async () => {
  const { engine, items } = fixture({ documents: Array.from({ length: 90 }, (_, index) => ({
    id: index + 1, dateAdded: index === 89 ? '2030-01-01 00:00:00' : '2025-01-01 00:00:00',
  })) });
  const ranked = await engine.sortNativeResults({ items: [...items.values()], sortMode: 'dateAddedDesc' });
  const first = await engine.presentNativeResults({ items: ranked, limit: 1 });
  assert.equal(first.results[0].id, 90); assert.equal(first.total, 90);
  await assert.rejects(engine.sortNativeResults({ items: [...items.values()], sortMode: 'dateAddedAsc', isCancelled: () => true }), { name: 'AbortError' });
});

test('date sorting uses the primary-data loader that reuses Zotero cached records', async () => {
  const { engine, items } = fixture({ documents: [{ id: 1 }, { id: 2 }] });
  let primaryLoads = 0;
  for (const item of items.values()) {
    item.loadDataType = async () => { throw new Error('Must not force-reload cached primary data'); };
    item.loadPrimaryData = async () => { primaryLoads++; item.dateAdded = item.id === 1 ? '2024-01-01' : '2026-01-01'; };
  }
  const ordered = await engine.sortNativeResults({ items: [...items.values()], sortMode: 'dateAddedDesc' });
  assert.deepEqual(ordered.map(item => item.id), [2, 1]); assert.equal(primaryLoads, 2);
});

test('sorting defaults to relevance and rejects unknown modes', async () => {
  const { engine, items } = fixture({ documents: [
    { id: 1, fields: { title: 'generator' }, dateAdded: '2030-01-01' },
    { id: 2, fields: { title: 'triboelectric nanogenerator' }, dateAdded: '2020-01-01' },
  ] });
  const ranked = await engine.sortNativeResults({ query: 'triboelectric nanogenerator', items: [...items.values()] });
  assert.deepEqual(ranked.map(item => item.id), [2, 1]);
  await assert.rejects(engine.sortNativeResults({ sortMode: 'publicationYear' }), /지원하지 않는/);
});

test('controller sort preference validates, persists across instances and refreshes current inline views', () => {
  const saved = new Map(), writes = [], refreshes = [];
  const makeController = () => Object.assign(Object.create(Controller.prototype), {
    Zotero: { locale: 'ko-KR', Prefs: { get: key => saved.get(key), set(key, value) { saved.set(key, value); writes.push([key, value]); } } },
    inlineWindows: new Map([[1, { refreshSearch() { refreshes.push(1); } }], [2, { refreshSearch() { refreshes.push(2); } }]]),
    destroyed: false,
  });
  const controller = makeController();
  assert.equal(controller.getSortMode(), 'relevance');
  assert.equal(controller.setSortMode('dateAddedDesc'), 'dateAddedDesc');
  assert.deepEqual(writes, [['contextSearch.sortMode', 'dateAddedDesc']]);
  assert.deepEqual(refreshes, [1, 2]);
  assert.equal(makeController().getSortMode(), 'dateAddedDesc');
  assert.throws(() => controller.setSortMode('year'), /유효한/);
  assert.equal(writes.length, 1); assert.equal(refreshes.length, 2);
  saved.set('contextSearch.sortMode', 'unknown');
  assert.equal(controller.getSortMode(), 'relevance');
  controller.destroyed = true;
  controller.setSortMode('dateAddedAsc');
  assert.equal(writes.length, 1);
});

test('changing sort reuses the native scope, resets pagination, cancels stale pages and cleans up refresh', async () => {
  const timers = new Map(), saved = new Map(), sorts = [], pages = [], refreshListeners = new Set();
  const nativeItems = [{ id: 1 }, { id: 2 }];
  let nextTimer = 0, nativeSearches = 0, shownOriginal = 0;
  const clearButton = new EventTarget(), quick = new EventTarget();
  quick.searchTextbox = { value: 'same query', shadowRoot: { querySelector: () => clearButton } };
  const view = { viewMode: 'default', getSortedItems: () => nativeItems,
    onRefresh: { addListener: fn => refreshListeners.add(fn), removeListener: fn => refreshListeners.delete(fn) } };
  const win = { document: { getElementById: id => id === 'zotero-tb-search' ? quick : null },
    ZoteroPane: { itemsView: view, async search() { nativeSearches++; } },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  };
  const inline = { renderLoading() {}, showOriginal() { shownOriginal++; },
    render(data, query, loadPage) { this.lastData = data; this.lastQuery = query; this.loadPage = loadPage; },
    renderError(message) { assert.fail(message); } };
  const controller = Object.assign(Object.create(Controller.prototype), {
    Zotero: { Prefs: { get: key => saved.get(key), set: (key, value) => saved.set(key, value) }, logError: error => { throw error; } },
    search: { async sortNativeResults(args) { sorts.push(args); return args.items; },
      async presentNativeResults(args) { pages.push(args); return { results: args.items, cancelled: false }; } },
    inlineWindows: new Map([[win, inline]]), destroyed: false,
  });
  const flush = async () => {
    const pending = [...timers.entries()];
    for (const [id, fn] of pending) { timers.delete(id); await fn(); }
  };
  const cleanup = controller._installInlineSearch(win, inline);
  await flush();
  assert.equal(nativeSearches, 1); assert.equal(sorts[0].sortMode, 'relevance');
  const oldPageLoader = inline.loadPage;
  await oldPageLoader(40);
  controller.setSortMode('dateAddedAsc');
  assert.equal(await oldPageLoader(80), null, 'previous result page must be discarded after changing sort');
  await flush();
  assert.equal(nativeSearches, 1, 'sorting must not rerun the native query or broaden its scope');
  assert.equal(sorts.at(-1).items, nativeItems);
  assert.equal(sorts.at(-1).query, 'same query'); assert.equal(sorts.at(-1).sortMode, 'dateAddedAsc');
  assert.equal(pages.at(-1).offset, 0); assert.equal(inline.lastQuery, 'same query');
  quick.searchTextbox.value = '';
  inline.refreshSearch(); assert.equal(timers.size, 0); assert.ok(shownOriginal > 0);
  const oldRefresh = inline.refreshSearch;
  for (const close of cleanup) close();
  assert.equal(inline.refreshSearch, undefined); assert.equal(refreshListeners.size, 0);
  quick.searchTextbox.value = 'after cleanup'; oldRefresh(); assert.equal(timers.size, 0);
});

test('ranks all 630 native candidates before pagination; exact body phrase outranks partial title', async () => {
  const documents = Array.from({ length: 630 }, (_, i) => ({ id: i + 1, fields: { title: 'Triboelectric generator ' + i } }));
  documents[629].fields.title = 'A Triboelectric Nanogenerator for power';
  documents[628].fields.title = 'A nanogenerator driven by triboelectric power';
  documents[627].attachments = [900];
  documents.push({ id: 900, parentItemID: 628, pdf: true });
  documents.push({ id: 999, fields: { title: 'Outside collection: Triboelectric Nanogenerator' } });
  const { engine, items, scopes, reads, drops } = nativePhraseFixture({ documents }, { hits: { 1: [900, 999] } });
  const ranked = await engine.rankNativeResults({ query: 'Triboelectric Nanogenerator', items: documents.slice(0, 630).map(d => items.get(d.id)) });
  assert.deepEqual(ranked.slice(0, 3).map(item => item.id), [630, 628, 629]);
  assert.equal(ranked.length, 630);
  assert.equal(ranked.some(item => item.id === 999), false);
  assert.deepEqual(reads, [], 'ranking must not read every PDF cache in the plugin');
  assert.equal(scopes.length, 1); assert.equal(scopes[0].ids.length, 630);
  assert.deepEqual(scopes[0].conditions, [['fulltextContent', 'contains', 'triboelectric nanogenerator']]);
  assert.equal(drops.length, 1);
  const page = await engine.presentNativeResults({ query: 'Triboelectric Nanogenerator', items: ranked, limit: 1 });
  assert.equal(page.results[0].id, 630); assert.equal(page.total, 630); assert.equal(page.hasMore, true);
});

test('ranking preserves multi-library scope, parent mapping, native ties and complete word boundaries', async () => {
  const documents = [
    { id: 1, fields: { title: 'Triboelectric nanogenerators' } },
    { id: 2, fields: { title: 'Other title' }, libraryID: 2 },
    { id: 3, fields: { title: 'Other title' } },
    { id: 4, fields: { title: 'Triboelectric nanogenerator' }, libraryID: 2 },
    { id: 5, fields: { title: 'Triboelectric nanogenerator' } },
    { id: 20, parentItemID: 2, pdf: true, libraryID: 2 },
    { id: 30, parentItemID: 3, pdf: true },
  ];
  const { engine, items, scopes } = nativePhraseFixture({ documents }, { hits: { 1: [30, 20], 2: [20, 30] } });
  const ranked = await engine.rankNativeResults({ query: '"Triboelectric Nanogenerator"', items: [1, 20, 2, 3, 4, 5].map(id => items.get(id)) });
  assert.deepEqual(ranked.map(item => item.id), [4, 5, 2, 3, 1]);
  assert.deepEqual(scopes.map(scope => [scope.libraryID, scope.ids]), [[1, [1, 3, 5]], [2, [2, 4]]]);
});

test('phrase ranking cache is bounded to current scope, expires and invalidates', async () => {
  const { engine, items, scopes } = nativePhraseFixture({ documents: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  const request = { query: 'stored charge', items: [items.get(1), items.get(2)] };
  await engine.rankNativeResults(request); await engine.rankNativeResults(request);
  assert.equal(scopes.length, 1);
  await engine.rankNativeResults({ ...request, items: [items.get(1), items.get(3)] });
  assert.equal(scopes.length, 2);
  for (const cached of engine._phraseCache.values()) cached.time = 0;
  await engine.rankNativeResults(request); assert.equal(scopes.length, 3);
  engine.invalidate(); await engine.rankNativeResults(request); assert.equal(scopes.length, 4);
  for (let i = 0; i < 10; i++) await engine.rankNativeResults({ ...request, query: 'charge ' + i });
  assert.equal(engine._phraseCache.size, 8);
});

test('ranking cancellation and lookup failures clean up native temporary scope', async () => {
  let cancelled = false;
  const cancelledFixture = nativePhraseFixture({ documents: [{ id: 1 }, { id: 2 }] }, { onSearch() { cancelled = true; } });
  await assert.rejects(cancelledFixture.engine.rankNativeResults({ query: 'stored charge', items: [...cancelledFixture.items.values()], isCancelled: () => cancelled }), { name: 'AbortError' });
  assert.equal(cancelledFixture.drops.length, 1);
  assert.equal(cancelledFixture.engine._phraseCache.size, 0);
  const failed = nativePhraseFixture({ documents: [{ id: 1 }, { id: 2, fields: { title: 'Stored charge' } }] }, { fail: true });
  const ranked = await failed.engine.rankNativeResults({ query: 'stored charge', items: [...failed.items.values()] });
  assert.deepEqual(ranked.map(item => item.id), [2, 1]);
  assert.equal(failed.errors.length, 1); assert.equal(failed.drops.length, 1);
});

test('single-word typing uses metadata only; missing native scope API falls back safely', async () => {
  const { engine, items, searches } = fixture({ documents: [
    { id: 1, fields: { title: 'nanogenerator' } }, { id: 2, fields: { title: 'generator' } },
    { id: 3, fields: { title: 'stored charge' } }, { id: 4, tags: ['stored', 'charge'] },
  ] });
  const ranked = await engine.rankNativeResults({ query: 'generator', items: [...items.values()] });
  assert.equal(ranked[0].id, 2); assert.equal(searches.length, 0);
  const fallback = await engine.rankNativeResults({ query: 'stored charge', items: [...items.values()] });
  assert.equal(fallback[0].id, 3);
});

test('later PDF and abstract complete phrases are shown before first PDF fragments', async () => {
  const { engine, items } = fixture({ documents: [
    { id: 1, attachments: [11, 12], fields: { abstractNote: 'Abstract stored charge result.' } },
    { id: 11, parentItemID: 1, pdf: true }, { id: 12, parentItemID: 1, pdf: true },
  ], text: {
    '/cache/11': ('The stored value changes. ' + 'Filler sentence. '.repeat(80)).repeat(3),
    '/cache/12': 'Before sentence. Stored charge is retained. After sentence.',
  } });
  const result = await engine.presentNativeResults({ query: 'stored charge', items: [items.get(1)] });
  const snippets = result.results[0].snippets;
  assert.equal(snippets[0].attachmentID, 12);
  assert.equal(snippets[1].source, 'abstract');
  assert.ok(snippets.slice(0, 2).every(snippet => snippet.relevance.exactPhrase));
});

test('native candidates first; only current-page text read; entire cached text searched', async () => {
  const { engine, searches, reads } = fixture({
    ids: [1, 2, 3],
    documents: [1, 2, 3].flatMap(id => [{ id, fields: { title: 'Paper ' + id }, attachments: [id + 10] }, { id: id + 10, pdf: true }]),
    text: { '/cache/13': 'Introduction. '.repeat(50000) + 'The needle appears only at the end.' },
  });
  const output = await engine.search({ query: 'needle', libraryID: 1, limit: 1 });
  assert.deepEqual(searches[0].conditions[0], ['resultLevel', 'item']);
  assert.ok(searches[0].conditions.some(c => c[0] === 'quicksearch-everything' && c[2] === 'needle'));
  assert.equal(searches[0].libraryID, 1);
  assert.deepEqual(reads, ['/cache/13']);
  assert.equal(output.total, 3); assert.equal(output.hasMore, true);
  assert.equal(output.results[0].id, 3);
  assert.match(output.results[0].snippets[0].text, /needle appears only at the end/);
  assert.equal(output.results[0].snippets[0].attachmentID, 13);
});

test('inline results preserve native scope/order and map expanded children without another search', async () => {
  const { engine, searches, items } = fixture({ documents: [
    { id: 1, fields: { title: 'First' } }, { id: 2, fields: { title: 'Outside collection' } },
    { id: 3, fields: { title: 'Another library' }, libraryID: 2 },
    { id: 11, pdf: true, parentItemID: 1 }, { id: 12, deleted: true },
  ] });
  const result = await engine.presentNativeResults({ query: 'term', items: [items.get(3), items.get(11), items.get(1), items.get(12)] });
  assert.deepEqual(result.results.map(row => row.id), [3, 1]);
  assert.equal(result.total, 2);
  assert.equal(searches.length, 0);
});

test('inline pagination does not hide remaining rows and supports standalone PDFs/notes', async () => {
  const { engine, items } = fixture({ documents: Array.from({ length: 125 }, (_, i) => ({ id: i + 1,
    ...(i === 124 ? { pdf: true } : i === 123 ? { note: 'needle note' } : {}),
  })) });
  const candidates = [...items.values()];
  const first = await engine.presentNativeResults({ query: 'needle', items: candidates, limit: 40 });
  assert.equal(first.nextOffset, 40); assert.equal(first.hasMore, true);
  const last = await engine.presentNativeResults({ query: 'needle', items: candidates, offset: 120 });
  assert.deepEqual(last.results.map(row => row.id), [121, 122, 123, 124, 125]);
  assert.equal(last.hasMore, false); assert.equal(last.nextOffset, 125);
  assert.equal(last.results.at(-1).canFavorite, false);
  const cancelled = await engine.presentNativeResults({ query: 'needle', items: candidates, isCancelled: () => true });
  assert.equal(cancelled.cancelled, true); assert.deepEqual(cancelled.results, []);
});

test('pagination preserves every native candidate, with no hidden result limit', async () => {
  const docs = Array.from({ length: 125 }, (_, index) => ({ id: index + 1, fields: { title: 'Title' } }));
  const { engine, reads } = fixture({ ids: docs.map(doc => doc.id), documents: docs });
  const output = await engine.search({ query: 'Title', field: 'title', offset: 120, limit: 40 });
  assert.equal(output.total, 125); assert.equal(output.hasMore, false);
  assert.deepEqual(output.results.map(item => item.id), [5, 4, 3, 2, 1]);
  assert.deepEqual(reads, []);
});

test('PDF missing locally is irrelevant if synced extracted cache is present', async () => {
  const { engine } = fixture({ documents: [{ id: 1, attachments: [11] }, { id: 11, pdf: true }], text: { '/cache/11': '저장 전하량이 증가했다.' } });
  const result = await engine.search({ query: '전하량' });
  assert.equal(result.results[0].snippets[0].source, 'pdf');
  assert.deepEqual(result.warnings, []);
});

test('metadata-only hits never claim PDF snippets; missing cache reported without extraction', async () => {
  const { engine } = fixture({ documents: [{ id: 1, fields: { title: 'Needle paper' }, attachments: [11] }, { id: 11, pdf: true }] });
  const output = await engine.search({ query: 'needle' });
  assert.ok(output.results[0].matchedFields.includes('title'));
  assert.equal(output.results[0].matchedFields.includes('fulltext'), false);
  assert.deepEqual(output.results[0].snippets, []);
  assert.equal(output.warnings.length, 1);
});

test('favorites constraint and read-only metadata are preserved', async () => {
  const { engine, searches } = fixture({ documents: [{ id: 1, fields: { title: 'Starred' }, tags: ['★'], editable: false }] });
  const output = await engine.search({ favoritesOnly: true });
  assert.equal(searches[0].conditions.some(c => c[0] === 'tag' && c[2] === '⭐'), false);
  assert.ok(searches[0].conditions.some(c => c[0] === 'tag' && c[2] === '★'));
  assert.equal(output.results[0].starred, true); assert.equal(output.results[0].editable, false);
});

test('trashed or foreign-library records are not displayed if changed during search', async () => {
  const { engine } = fixture({ ids: [1, 2], documents: [{ id: 1, deleted: true }, { id: 2, libraryID: 2 }] });
  const output = await engine.search({ query: 'term' });
  assert.deepEqual(output.results, []);
  assert.equal(output.nextOffset, 2);
});

test('favorite controls explicitly disable standalone PDFs and notes', async () => {
  const { engine } = fixture({ ids: [1, 2, 3], documents: [{ id: 1 }, { id: 2, pdf: true }, { id: 3, note: 'A note' }] });
  const output = await engine.search({ query: 'title', field: 'title' });
  assert.equal(output.results.find(item => item.id === 1).canFavorite, true);
  assert.equal(output.results.find(item => item.id === 2).canFavorite, false);
  assert.equal(output.results.find(item => item.id === 3).canFavorite, false);
});

test('yields to input between cached results so cancellation stops the page', async () => {
  let cancelled = false, count = 0;
  const { engine, reads } = fixture({
    ids: [1, 2], documents: [{ id: 1, attachments: [11] }, { id: 11, pdf: true }, { id: 2, attachments: [12] }, { id: 12, pdf: true }],
    text: { '/cache/11': 'needle', '/cache/12': 'needle' },
    onYield() { if (++count === 2) cancelled = true; },
  });
  const output = await engine.search({ query: 'needle', isCancelled: () => cancelled });
  assert.equal(output.cancelled, true);
  assert.deepEqual(reads, ['/cache/12']);
  assert.deepEqual(output.results, []);
});

test('cancellation before native search and after cache read returns no stale results', async () => {
  let cancelled = false;
  const { engine, reads, searches } = fixture({
    documents: [{ id: 1, attachments: [11] }, { id: 11, pdf: true }], text: { '/cache/11': 'target' }, onRead() { cancelled = true; },
  });
  const before = await engine.search({ query: 'target', isCancelled: () => true });
  assert.equal(before.cancelled, true); assert.equal(searches.length, 0); assert.equal(reads.length, 0);
  const after = await engine.search({ query: 'target', isCancelled: () => cancelled });
  assert.equal(after.cancelled, true); assert.deepEqual(after.results, []);
});

test('text cache is bounded and can be invalidated without changing library data', async () => {
  const { engine, reads } = fixture({ documents: [{ id: 1, attachments: [11] }, { id: 11, pdf: true }], text: { '/cache/11': 'needle cache' } });
  await engine.search({ query: 'needle' }); await engine.search({ query: 'cache' });
  assert.equal(reads.length, 1);
  engine.clearCache(); await engine.search({ query: 'needle' });
  assert.equal(reads.length, 2);
  engine._maxCacheChars = 3; engine.clearCache(); await engine.search({ query: 'needle' });
  assert.equal(engine._textCache.size, 0);
});

test('fulltext phrases use native literal content conditions, not regex or indexing', async () => {
  const { engine, searches } = fixture({ ids: [] });
  await engine.search({ query: '"stored charge" 전하', field: 'fulltext' });
  assert.deepEqual(searches[0].conditions.slice(1), [
    ['fulltextContent', 'contains', 'stored charge'], ['fulltextContent', 'contains', '전하'],
  ]);
});

test('empty and unfinished quote-only queries never expand to an all-items search', async () => {
  const { engine, searches } = fixture({ documents: [{ id: 1, fields: { title: 'Must not appear' } }] });
  for (const query of ['""', '" "', '"', '"" ""']) {
    for (const field of ['all', 'fulltext']) {
      const result = await engine.search({ query, field });
      assert.equal(result.total, 0);
      assert.deepEqual(result.results, []);
      assert.equal(result.warnings.length, 1);
    }
  }
  assert.equal(searches.length, 0);
  await engine.search({ query: '', favoritesOnly: true });
  assert.equal(searches.length, 1);
  assert.ok(searches[0].conditions.some(c => c[0] === 'tag' && c[2] === '★'));
});

test('search can cancel during one large PDF context scan, without waiting for the next document', async () => {
  let yields = 0, cancelled = false;
  const { engine, items, reads } = fixture({ documents: [
    { id: 1, attachments: [11] }, { id: 11, parentItemID: 1, pdf: true },
  ], text: { '/cache/11': 'Unrelated text. '.repeat(220000) + 'Needle only at the end.' },
  onYield() { if (++yields === 4) cancelled = true; } });
  const output = await engine.presentNativeResults({ query: 'needle', items: [items.get(1)], isCancelled: () => cancelled });
  assert.equal(output.cancelled, true); assert.deepEqual(output.results, []);
  assert.deepEqual(reads, ['/cache/11']); assert.equal(yields, 4);
});

test('ranking can cancel while scanning a large untrusted metadata field', async () => {
  let yields = 0, cancelled = false;
  const { engine, items, searches, reads } = fixture({ documents: [
    { id: 1, fields: { title: 'Unrelated text. '.repeat(220000) + 'Stored charge' } }, { id: 2 },
  ], onYield() { if (++yields === 3) cancelled = true; } });
  await assert.rejects(engine.rankNativeResults({ query: 'stored charge', items: [...items.values()], isCancelled: () => cancelled }), { name: 'AbortError' });
  assert.equal(yields, 3); assert.deepEqual(reads, []); assert.equal(searches.length, 0);
});

test('PDF page metadata is reused with text cache and refreshed on invalidation', async () => {
  const { engine, Zotero, reads } = fixture({ documents: [
    { id: 1, attachments: [11] }, { id: 11, pdf: true },
  ], text: { '/cache/11': 'First introductory page.\fSecond target page.' } });
  const pageReads = [];
  let indexedPages = 2;
  Zotero.Fulltext.getPages = async id => { pageReads.push(id); return { indexedPages, total: 100 }; };
  for (const query of ['target', 'second']) {
    const result = await engine.search({ query });
    assert.equal(result.results[0].snippets[0].pageNumber, 2);
    assert.equal(result.results[0].snippets[0].endPageNumber, 2);
  }
  assert.deepEqual(pageReads, [11]); assert.deepEqual(reads, ['/cache/11']);
  indexedPages = 3;
  engine.invalidate([11]);
  const result = await engine.search({ query: 'target' });
  assert.equal(result.results[0].snippets[0].pageNumber, undefined);
  assert.deepEqual(pageReads, [11, 11]); assert.deepEqual(reads, ['/cache/11', '/cache/11']);
});

test('missing page statistics retain PDF snippets without numbering metadata or notes', async () => {
  const { engine, Zotero } = fixture({ documents: [
    { id: 1, attachments: [11], notes: [12], fields: { abstractNote: 'Target abstract.\fAnother page-like section.' } },
    { id: 11, pdf: true }, { id: 12, note: '<p>Target note.</p>\f<p>Another section.</p>' },
  ], text: { '/cache/11': 'Target PDF.\fAnother page.' } });
  Zotero.Fulltext.getPages = async () => { throw new Error('Missing stats'); };
  Zotero.PDFWorker = { getFullText() { assert.fail('Must not parse PDF for page numbers'); } };
  const result = await engine.search({ query: 'target' });
  assert.deepEqual(result.results[0].snippets.map(snippet => snippet.source), ['pdf', 'abstract', 'note']);
  assert.ok(result.results[0].snippets.every(snippet => !Object.hasOwn(snippet, 'pageNumber')));
  assert.deepEqual(result.warnings, []);
  engine.invalidate();
  Zotero.Fulltext.getPages = async () => ({ indexedPages: 2, total: 2 });
  const withStats = await engine.search({ query: 'target' });
  assert.equal(withStats.results[0].snippets[0].pageNumber, 1);
  assert.ok(withStats.results[0].snippets.slice(1).every(snippet => !Object.hasOwn(snippet, 'pageNumber')));
});

test('cancellation while reading native page statistics returns no stale excerpts', async () => {
  let cancelled = false;
  const { engine, Zotero } = fixture({ documents: [{ id: 1, attachments: [11] }, { id: 11, pdf: true }],
    text: { '/cache/11': 'First.\fTarget.' } });
  Zotero.Fulltext.getPages = async () => { cancelled = true; return { indexedPages: 2, total: 2 }; };
  const result = await engine.search({ query: 'target', isCancelled: () => cancelled });
  assert.equal(result.cancelled, true); assert.deepEqual(result.results, []);
  assert.equal(engine._textCache.size, 0);
});

test('search metadata labels follow the UI locale while bibliographic values and tags remain unchanged', async () => {
  const data = { ids: [1, 2, 3], documents: [
    { id: 1, fields: { title: '저장된 논문', publicationTitle: '가상 저널', date: '2024' }, tags: ['★', '한국어 태그'], creators: [{ name: '저자 이름', creatorTypeID: 1 }] },
    { id: 2, fields: { title: 'Book chapter', bookTitle: 'Stored Book' }, creators: [{ name: 'Sample Editor', creatorTypeID: 3 }] },
    { id: 3, fields: { proceedingsTitle: 'Stored Proceedings' } },
  ] };
  const english = await fixture({ ...data, locale: 'en-US' }).engine.search();
  const korean = await fixture({ ...data, locale: 'ko-KR' }).engine.search();
  const en = new Map(english.results.map(item => [item.id, item]));
  const ko = new Map(korean.results.map(item => [item.id, item]));
  assert.deepEqual([en.get(1).creatorsLabel, en.get(2).creatorsLabel], ['Authors', 'Contributors']);
  assert.deepEqual([en.get(1).publicationLabel, en.get(2).publicationLabel, en.get(3).publicationLabel], ['Journal', 'Book', 'Conference']);
  assert.deepEqual([ko.get(1).creatorsLabel, ko.get(2).creatorsLabel], ['저자', '기여자']);
  assert.deepEqual([ko.get(1).publicationLabel, ko.get(2).publicationLabel, ko.get(3).publicationLabel], ['저널', '수록도서', '학술대회']);
  assert.equal(en.get(3).title, 'Untitled');
  assert.equal(ko.get(3).title, '제목 없음');
  for (const key of ['title', 'creators', 'publication', 'year', 'tags']) assert.deepEqual(en.get(1)[key], ko.get(1)[key]);
  assert.equal(en.get(1).title, '저장된 논문');
  assert.deepEqual(en.get(1).tags, ['★', '한국어 태그']);
  assert.equal(en.get(1).starred, true);
});

test('English search validation and cache warnings explain the same native-search limitations', async () => {
  const { engine, Zotero, items } = fixture({ locale: 'en-US', documents: [
    { id: 1, attachments: [11] }, { id: 11, pdf: true },
  ] });
  for (const method of ['search', 'rankNativeResults', 'presentNativeResults']) {
    await assert.rejects(engine[method]({ query: 'a'.repeat(1025) }), /1024 characters or fewer/);
  }
  await assert.rejects(engine.sortNativeResults({ sortMode: 'invalid' }), /sort order is not supported/);
  await assert.rejects(engine.search({ libraryID: -1 }), /Select a valid library/);
  await assert.rejects(engine.search({ field: 'invalid' }), /Unknown search field: invalid/);
  for (const method of ['search', 'presentNativeResults']) {
    const empty = await engine[method]({ query: '""' });
    assert.deepEqual(empty.warnings, ['Enter a search term inside the quotation marks.']);
  }
  Zotero.FullText = { canSearchContent: () => false };
  const native = await engine.search({ query: 'a' });
  const inline = await engine.presentNativeResults({ query: 'a', items: [items.get(1)] });
  assert.ok(native.warnings.some(message => /full-text filter/.test(message)));
  assert.ok(inline.warnings.some(message => /Enclose them in double quotation marks/.test(message)));
  for (const result of [native, inline]) {
    assert.ok(result.warnings.some(message => /existing extracted text was unavailable/.test(message)));
    assert.doesNotMatch(result.warnings.join(' '), /[가-힣]/);
  }
});
