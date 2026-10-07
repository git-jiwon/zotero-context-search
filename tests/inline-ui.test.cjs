const test = require("node:test");
const assert = require("node:assert/strict");
const InlineUI = require("../addon/content/inline-ui.js");
const core = require("../addon/content/snippets.js");

function fixture() {
  const document = {
    createElementNS: (_, tag) => ({ tag, textContent: "" }),
    createTextNode: text => ({ tag: "#text", textContent: text }),
  };
  const ui = new InlineUI({ Zotero: {}, controller: { core }, win: { document } });
  const nodes = [];
  return { ui, nodes, element: { append: node => nodes.push(node) } };
}

test("large imported metadata has a bounded DOM and does not split a surrogate pair", () => {
  const { ui, nodes, element } = fixture();
  const value = "a ".repeat(2047) + "a😀" + "a ".repeat(500000);
  ui.highlighted(element, value, "a");
  const rendered = nodes.map(node => node.textContent).join("");
  assert.equal(rendered, value.slice(0, 4095) + "…");
  assert.ok(nodes.length <= 4097);
  assert.equal(value.length, 1004097);
});

test("metadata markup stays literal and supplied context segments are preserved", () => {
  const { ui, nodes, element } = fixture();
  ui.highlighted(element, '<img src=x onerror="attack()">literal', "literal");
  assert.equal(nodes.map(node => node.textContent).join(""), '<img src=x onerror="attack()">literal');
  assert.ok(nodes.every(node => ["#text", "mark"].includes(node.tag)));
  const second = fixture();
  second.ui.highlighted(second.element, "ignored", "ignored", [{ text: "context", match: true }]);
  assert.deepEqual(second.nodes, [{ tag: "mark", textContent: "context" }]);
});

function windowFixture({ hidden = false, display = "", priority = "" } = {}) {
  const properties = new Map(display ? [["display", { value: display, priority }]] : []);
  function element(tag) {
    return {
      tag, children: [], hidden: false,
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this[name] = value; },
      remove() { this.removed = true; },
    };
  }
  const tree = element("div");
  tree.hidden = hidden;
  tree.style = {
    getPropertyValue: name => properties.get(name)?.value || "",
    getPropertyPriority: name => properties.get(name)?.priority || "",
    setProperty: (name, value, priority = "") => properties.set(name, { value, priority }),
    removeProperty: name => properties.delete(name),
  };
  const pane = element("hbox");
  // Pane/splitter sizing belongs to Zotero; the inline view must leave it alone.
  pane.style = Object.freeze({ width: "447px" });
  pane.setAttribute = () => assert.fail("The inline view changed a native pane attribute");
  const document = {
    documentElement: element("window"),
    createElementNS: (_, tag) => element(tag),
    getElementById: id => ({ "zotero-items-pane": pane, "zotero-items-tree": tree })[id],
  };
  const ui = new InlineUI({ Zotero: {}, controller: { core }, win: { document } });
  return { ui, pane, tree, document };
}

test("inline loading, clear and teardown preserve native pane sizing and tree display", () => {
  for (const original of [
    { hidden: false, display: "", priority: "" },
    { hidden: true, display: "grid", priority: "important" },
  ]) {
    const { ui, pane, tree, document } = windowFixture(original);
    ui.addToWindow();
    ui.addToWindow();
    assert.equal(pane.children.length, 1);
    assert.equal(document.documentElement.children.length, 1);
    assert.equal(ui.host.hidden, true);
    ui.renderLoading("a long literal query");
    assert.equal(tree.hidden, true);
    assert.equal(tree.style.getPropertyValue("display"), "none");
    assert.equal(tree.style.getPropertyPriority("display"), "important");
    assert.equal(ui.host.hidden, false);
    ui.showOriginal();
    assert.equal(ui.host.hidden, true);
    assert.equal(ui.host.children.length, 0);
    assert.equal(tree.hidden, original.hidden);
    assert.equal(tree.style.getPropertyValue("display"), original.display);
    assert.equal(tree.style.getPropertyPriority("display"), original.priority);
    ui.renderLoading("active at teardown");
    const host = ui.host, style = ui.style;
    ui.destroy();
    assert.equal(host.removed, true);
    assert.equal(style.removed, true);
    assert.equal(ui.host, null);
    assert.equal(tree.hidden, original.hidden);
    assert.equal(tree.style.getPropertyValue("display"), original.display);
    assert.equal(tree.style.getPropertyPriority("display"), original.priority);
    assert.equal(pane.style.width, "447px");
    ui.addToWindow();
    assert.equal(pane.children.length, 1);
  }
});

function resultFixture(locale = 'ko-KR') {
  function element(tag) {
    return {
      tag, children: [], dataset: {}, listeners: {}, classList: { add() {} },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
    };
  }
  const document = {
    createElementNS: (_, tag) => element(tag),
    createTextNode: text => ({ tag: '#text', textContent: text }),
    createDocumentFragment: () => element('fragment'),
  };
  const calls = [], errors = [];
  const controller = {
    core, favorites: {},
    getSortMode: () => 'relevance',
    setSortMode(mode) { calls.push(['sort', mode]); },
    async openAttachment(...args) { calls.push(['page', ...args]); },
    async openResultFile(...args) { calls.push(['file', ...args]); },
    reportError(...args) { errors.push(args); },
  };
  const win = { document };
  const ui = new InlineUI({ Zotero: { locale }, controller, win });
  ui.host = element('div');
  const result = { id: 1, title: 'Example', canFavorite: true, hasPDF: true, snippets: [] };
  const all = node => [node, ...(node.children || []).flatMap(all)];
  const byClass = (node, name) => all(node).filter(child => (child.className || '').split(' ').includes(name));
  return { ui, result, controller, calls, errors, win, byClass, all };
}

test('page labels open their own attachment and match page without duplicate generic PDF titles', async () => {
  const { ui, result, calls, win, byClass } = resultFixture();
  result.snippets = [
    { source: 'pdf', attachmentID: 11, attachmentTitle: 'PDF', text: 'First', pageNumber: 2, endPageNumber: 2 },
    { source: 'pdf', attachmentID: 12, attachmentTitle: 'Supplement', text: 'Second', pageNumber: 7, endPageNumber: 8 },
  ];
  const row = ui.renderResult(result, '');
  const pages = byClass(row, 'zcs-snippet-page');
  assert.deepEqual(pages.map(page => page.textContent), ['PDF p. 2', 'PDF pp. 7–8']);
  assert.deepEqual(byClass(row, 'zcs-inline-attachment').map(node => node.textContent), ['Supplement']);
  await pages[1].listeners.click();
  assert.deepEqual(calls, [['page', 12, win, 7]]);
});

test('missing or invalid page metadata keeps an unnumbered source and no page action', () => {
  const { ui, result, byClass } = resultFixture();
  result.snippets = [
    { source: 'pdf', attachmentID: 11, text: 'Unknown' },
    { source: 'pdf', attachmentID: 11, text: 'Invalid', pageNumber: 0 },
    { source: 'note', attachmentID: 12, text: 'Note', pageNumber: 2 },
  ];
  const row = ui.renderResult(result, '');
  assert.equal(byClass(row, 'zcs-snippet-page').length, 0);
  assert.deepEqual(byClass(row, 'zcs-inline-source').map(node => node.children[0].textContent), ['PDF 본문', 'PDF 본문', '노트']);
});

test('page and title clicks share the open guard and report file failures', async () => {
  const { ui, result, controller, calls, errors, byClass } = resultFixture();
  result.snippets = [{ source: 'pdf', attachmentID: 11, text: 'Match', pageNumber: 2 }];
  const row = ui.renderResult(result, '');
  let reject;
  controller.openAttachment = () => new Promise((_, fail) => { reject = fail; });
  const pending = byClass(row, 'zcs-snippet-page')[0].listeners.click();
  await byClass(row, 'zcs-inline-title')[0].listeners.click({ type: 'click' });
  assert.equal(calls.length, 0);
  reject(new Error('Missing file'));
  await pending;
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], '첨부파일 열기');
  await byClass(row, 'zcs-inline-title')[0].listeners.click({ type: 'click' });
  assert.equal(calls[0][0], 'file');
});

test('English results localize controls and accessibility labels while preserving reference text', () => {
  const { ui, result, calls, byClass, all } = resultFixture('en-US');
  result.title = '한국어 논문 제목';
  result.creators = '홍길동';
  result.snippets = [{ source: 'pdf', attachmentID: 11, text: 'Original text', pageNumber: 2 }];
  ui.render({ total: 1, results: [result] }, 'text');
  const nodes = all(ui.host);
  assert.ok(nodes.some(node => node.textContent === 'Full Search'));
  assert.equal(byClass(ui.host, 'zcs-inline-count')[0].textContent, '1 result');
  assert.deepEqual(byClass(ui.host, 'zcs-inline-sort-button').map(node => node.textContent), ['Relevance', 'Recently Added ↓']);
  assert.deepEqual(byClass(ui.host, 'zcs-inline-meta-label').map(node => node.textContent), ['Authors', 'Year', 'Journal']);
  assert.equal(byClass(ui.host, 'zcs-snippet-page')[0]['aria-label'], 'Open PDF at p. 2');
  assert.equal(byClass(ui.host, 'zcs-inline-star')[0]['aria-label'], 'Add to favorites');
  assert.ok(nodes.some(node => node.textContent === result.title));
  assert.ok(nodes.some(node => node.textContent === result.creators));
  assert.ok(byClass(ui.host, 'zcs-inline-action').some(node => node.textContent === 'Show in Library'));
  assert.ok(byClass(ui.host, 'zcs-inline-action').some(node => node.textContent === 'Copy Long Citation'));
  byClass(ui.host, 'zcs-inline-sort-button')[1].listeners.click();
  assert.deepEqual(calls, [['sort', 'dateAddedDesc']]);
});

test('English fallback, loading, empty results and errors use the same UI language', () => {
  const { ui, result, byClass, all } = resultFixture('fr-FR');
  result.snippets = [{ source: 'pdf', attachmentID: 1, text: 'Match' }];
  let row = ui.renderResult(result, 'match');
  assert.equal(byClass(row, 'zcs-inline-source')[0].children[0].textContent, 'PDF text');
  for (const render of [
    () => ui.renderLoading('query'),
    () => ui.render({ total: 0, results: [] }, 'query'),
    () => ui.renderError(),
  ]) {
    render();
    assert.ok(all(ui.host).some(node => node.textContent));
    assert.equal(all(ui.host).some(node => /[가-힣]/.test(node.textContent || '')), false);
  }
});
