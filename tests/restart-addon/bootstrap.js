var restartTest;
function install() {}
function uninstall() {}
function shutdown() {}
function startup() { restartTest = runRestartChecks(); }

async function waitFor(predicate, description) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + description);
}

async function runRestartChecks() {
  let root, validated = false, phase = 1;
  const report = { passed: false, checks: [] };
  const check = (name, pass, detail) => {
    report.checks.push({ name, passed: !!pass, detail });
    if (!pass) throw new Error("Check failed: " + name);
  };
  try {
    await Zotero.initializationPromise;
    root = Zotero.Prefs.get("contextSearch.integrationRoot");
    if (!root || !(await IOUtils.exists(PathUtils.join(root, ".context-search-isolated-test")))
        || Zotero.Profile.dir.toLowerCase() !== PathUtils.join(root, "profile").toLowerCase()
        || Zotero.DataDirectory.dir.toLowerCase() !== PathUtils.join(root, "data").toLowerCase()) {
      throw new Error("Refusing restart checks outside the isolated profile/data directory");
    }
    validated = true;
    const stateFile = PathUtils.join(root, "restart-state.json");
    const previous = await IOUtils.exists(stateFile) ? JSON.parse(await IOUtils.readUTF8(stateFile)) : null;
    phase = previous ? 2 : 1;
    report.phase = phase;
    report.version = Zotero.version;
    await waitFor(() => Zotero.getMainWindow()?.ZoteroPane?.itemsView, "native item list");
    const win = Zotero.getMainWindow();
    const plugin = await waitFor(() => Zotero.ContextSearchPlugin?.inlineWindows?.has(win)
      && Zotero.ContextSearchPlugin, "inline UI");
    const pane = win.ZoteroPane;
    await waitFor(() => pane.itemsView.tree, "rendered native item list");
    await Zotero.DB.waitForTransaction();
    const doc = win.document;
    const left = doc.getElementById("zotero-collections-pane");
    const right = doc.getElementById("zotero-item-pane");
    const center = doc.getElementById("zotero-items-pane-container");
    const settle = () => new Promise(resolve => win.setTimeout(resolve, 500));
    win.resizeTo(1200, 780);
    await settle();
    let item;
    if (phase === 1) {
      // Emulate saved splitter widths, using the same attributes Zotero persists.
      for (const [element, width] of [[left, 260], [right, 340]]) {
        element.setAttribute("width", String(width));
        element.style.width = `${width}px`;
      }
      item = new Zotero.Item("journalArticle");
      item.setField("title", "Sample Phrase in a fictional article " + "LongExample".repeat(35));
      item.setField("publicationTitle", "Fictional Journal " + "WideExample".repeat(25));
      item.setField("abstractNote", "A sample phrase appears here. " + "LongUnbrokenExample".repeat(50));
      item.setCreators([{ firstName: "Sample", lastName: "Author", creatorType: "author" }]);
      item.addTag("LongExampleTag".repeat(30));
      await item.saveTx();
    }
    else item = await Zotero.Items.getAsync(previous.itemID);
    await pane.selectItem(item.id);
    pane.updateLayoutConstraints();
    await settle();
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    const measure = () => ({ window: win.innerWidth, left: rect(left), center: rect(center), right: rect(right) });
    const before = measure();
    report.before = before;
    check("sidebarsVisibleBeforeSearch", before.left.width >= 200 && before.right.width >= 320
      && before.right.right <= before.window + 1, before);
    if (previous) {
      check("restartRestoresCollectionWidth", Math.abs(before.left.width - previous.before.left.width) <= 2, before);
      check("restartRestoresItemPaneWidth", Math.abs(before.right.width - previous.before.right.width) <= 2, before);
      check("restartRetainsSavedWidthAttributes", left.getAttribute("width") === previous.leftAttribute
        && right.getAttribute("width") === previous.rightAttribute);
    }
    const quick = doc.getElementById("zotero-tb-search");
    quick.searchTextbox.value = "Sample Phrase";
    quick.dispatchEvent(new win.Event("input", { bubbles: true }));
    await waitFor(() => doc.querySelector("#zcs-inline-results .zcs-inline-row"), "search results");
    await settle();
    const during = measure();
    report.during = during;
    check("searchKeepsCollectionWidth", Math.abs(during.left.width - before.left.width) <= 2, during);
    check("searchKeepsItemPaneWidth", Math.abs(during.right.width - before.right.width) <= 2, during);
    check("searchKeepsItemPaneInsideWindow", during.right.right <= during.window + 1, during);
    const host = doc.getElementById("zcs-inline-results");
    check("longTextDoesNotOverflowResults", host.scrollWidth <= host.clientWidth + 2,
      { scrollWidth: host.scrollWidth, clientWidth: host.clientWidth });
    const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = win.innerWidth; canvas.height = win.innerHeight;
    canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
    await IOUtils.write(PathUtils.join(root, `restart-phase-${phase}.png`),
      Uint8Array.from(win.atob(canvas.toDataURL("image/png").split(",")[1]), c => c.charCodeAt(0)));
    if (phase === 1) {
      pane.serializePersist();
      Services.prefs.savePrefFile(null);
      await IOUtils.writeUTF8(stateFile, JSON.stringify({ itemID: item.id, before,
        leftAttribute: left.getAttribute("width"), rightAttribute: right.getAttribute("width") }));
      // Quit with the search active; the next process reuses this exact profile.
    }
    else {
      await plugin.inlineWindows.get(win).clearSearch();
      await settle();
      const after = measure();
      check("clearRestoresNativeListWithoutChangingWidths", host.hidden
        && !doc.getElementById("zotero-items-tree").hidden
        && Math.abs(after.left.width - before.left.width) <= 2
        && Math.abs(after.right.width - before.right.width) <= 2, after);
    }
    report.passed = report.checks.every(value => value.passed);
  }
  catch (error) { report.error = String(error); report.stack = error.stack; }
  finally {
    if (validated) {
      await IOUtils.writeUTF8(PathUtils.join(root, `restart-phase-${phase}.json`), JSON.stringify(report));
      setTimeout(() => Services.startup.quit(Services.startup.eAttemptQuit), 500);
    }
  }
}
