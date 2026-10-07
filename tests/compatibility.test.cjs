const test = require("node:test");
const assert = require("node:assert/strict");
const Controller = require("../addon/content/controller.js");
const isNormalView = view => Controller.prototype._isNormalView(view);

test("Zotero 10 uses viewMode without reading the removed singular selection", () => {
  const view = { viewMode: "default", get collectionTreeRow() { throw new Error("Removed in Zotero 10"); } };
  assert.equal(isNormalView(view), true);
  for (const mode of ["trash", "duplicates", "feed", "feeds", "unfiled", "publications"]) {
    assert.equal(isNormalView({ viewMode: mode }), false);
  }
});

test("Zotero 9 library, collection and saved-search views enable inline results", () => {
  for (const method of ["isLibrary", "isCollection", "isSearch"]) {
    const row = { [method]: () => true };
    assert.equal(isNormalView({ collectionTreeRow: row }), true);
  }
});

test("Zotero 9 special or unavailable views retain the native list", () => {
  assert.equal(isNormalView(null), false);
  assert.equal(isNormalView({}), false);
  assert.equal(isNormalView({ collectionTreeRow: { isTrash: () => true } }), false);
  for (const method of ["isFeed", "isFeeds"]) {
    assert.equal(isNormalView({ collectionTreeRow: { isLibrary: () => true, [method]: () => true } }), false);
  }
});
