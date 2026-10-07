var integrationPromise;

// Independent expected UI strings. Never call the production translator here:
// --locale selects the requested language, and the actual application locale
// is checked separately before exercising either plugin or native UI.
function expectedUI(korean, english) {
  return Zotero.Prefs.get("contextSearch.integrationLocale") === "ko-KR" ? korean : english;
}

function checkEnglishUI(report, name, roots) {
  if (Zotero.Prefs.get("contextSearch.integrationLocale") !== "en-US") return;
  const unexpected = [];
  for (const root of roots.filter(Boolean)) {
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    while (walker.nextNode()) {
      if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(walker.currentNode.nodeValue)) {
        unexpected.push(walker.currentNode.nodeValue.trim().slice(0, 160));
      }
    }
    for (const element of [root, ...root.querySelectorAll("*")]) {
      for (const attribute of ["aria-label", "title", "tooltiptext", "label", "placeholder", "value"]) {
        const value = element.getAttribute(attribute) || "";
        if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(value)) unexpected.push(attribute + ": " + value);
      }
    }
  }
  check(report, name, unexpected.length === 0, unexpected);
}

function install() {}
function uninstall() {}
function shutdown() {}

function startup() {
  integrationPromise = runIntegration();
}

async function runIntegration() {
  const report = { passed: false, checks: [], errors: [], startedAt: new Date().toISOString() };
  let root;
  let isolatedValidated = false;
  try {
    await Zotero.initializationPromise;
    root = Zotero.Prefs.get("contextSearch.integrationRoot");
    if (!root || !(await IOUtils.exists(PathUtils.join(root, ".context-search-isolated-test")))) {
      throw new Error("Refusing integration checks: isolated-test marker missing");
    }
    const expectedProfile = PathUtils.join(root, "profile");
    const expectedData = PathUtils.join(root, "data");
    if (Zotero.Profile.dir.toLowerCase() !== expectedProfile.toLowerCase()
        || Zotero.DataDirectory.dir.toLowerCase() !== expectedData.toLowerCase()) {
      throw new Error("Refusing integration checks: profile/data directory mismatch");
    }
    isolatedValidated = true;
    report.version = Zotero.version;
    report.locale = Zotero.locale;
    report.requestedLocale = Zotero.Prefs.get("contextSearch.integrationLocale");
    report.applicationLocale = Services.locale.appLocaleAsBCP47;
    report.localePreference = Zotero.Prefs.get("intl.locale.requested", true);
    report.profile = Zotero.Profile.dir;
    report.dataDirectory = Zotero.DataDirectory.dir;
    check(report, "isolatedProfileAndData", true);
    check(report, "realApplicationUsesRequestedLocale", report.locale === report.requestedLocale
      && report.localePreference === report.requestedLocale
      && report.applicationLocale === report.requestedLocale,
      { actual: report.locale, application: report.applicationLocale,
        requested: report.requestedLocale, preference: report.localePreference });
    await waitFor(() => Zotero.getMainWindow()?.ZoteroPane?.itemsView, 30000, "main items view");
    const win = Zotero.getMainWindow();
    await waitFor(() => win.ZoteroPane.itemsView.tree, 30000, "rendered native item list");
    await Zotero.DB.waitForTransaction();
    win.document.title = "Zotero Context Search [ISOLATED TEST]";
    // Keep first-run notices out of demo screenshots. This executes only after
    // both test profile and data paths have passed the isolation checks above.
    win.ZoteroPane.hidePostUpgradeBanner?.();
    win.ZoteroPane.hideSyncReminder?.();
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Example research article");
    item.setField("date", "2024");
    item.setField("publicationTitle", "Fictional Journal");
    item.setField("journalAbbreviation", "Fict. J.");
    item.setField("volume", "1");
    item.setField("DOI", "10.0000/example-article");
    item.setCreators([
      { firstName: "Sample", lastName: "Author", creatorType: "author" },
      { firstName: "Demo", lastName: "Writer", creatorType: "author" },
    ]);
    await item.saveTx();
    const attachment = await Zotero.Attachments.importFromFile({
      file: PathUtils.join(root, "fixture.pdf"), parentItemID: item.id,
    });
    await Zotero.FullText.indexItems([attachment.id], { complete: true });
    const native = new Zotero.Search();
    native.libraryID = Zotero.Libraries.userLibraryID;
    native.addCondition("fulltextContent", "contains", "sample");
    const nativeIDs = await native.search();
    check(report, "nativePdfIndexFindsFixture", nativeIDs.includes(attachment.id), { nativeIDs, attachmentID: attachment.id });
    report.fixture = { itemID: item.id, itemKey: item.key, attachmentID: attachment.id, attachmentKey: attachment.key };
    await waitFor(() => Zotero.ContextSearchPlugin, 30000, "plugin controller");
    const plugin = Zotero.ContextSearchPlugin;
    report.controllerKeys = Object.keys(plugin);
    await runPluginChecks({ report, plugin, win, item, attachment, root });
    report.passed = report.checks.every(x => x.passed) && report.errors.length === 0;
  } catch (error) {
    report.errors.push({ message: String(error), stack: error.stack || "" });
  } finally {
    report.finishedAt = new Date().toISOString();
    if (isolatedValidated) {
      await IOUtils.writeUTF8(PathUtils.join(root, "result.json"), JSON.stringify(report, null, 2));
      try {
        await IOUtils.writeUTF8(PathUtils.join(root, "zotero-debug.txt"), Zotero.Debug.get());
      } catch (_) {}
      if (!Zotero.Prefs.get("contextSearch.integrationKeepOpen")) {
        setTimeout(() => Services.startup.quit(Services.startup.eAttemptQuit), 1000);
      }
    }
  }
}

function check(report, name, passed, detail) {
  Zotero.debug(`[Context Search integration] ${name}: ${passed ? "PASS" : "FAIL"}`);
  report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  if (!passed) throw new Error("Check failed: " + name);
}

async function waitFor(predicate, timeout, description) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for " + description);
}

function checkInlineLocalization({ report, inline, win }) {
  const row = inline.querySelector(".zcs-inline-row");
  const labels = [...row.querySelectorAll(".zcs-inline-meta-label")].map(node => node.textContent);
  check(report, "metadataFieldLabelsFollowAppLanguage", JSON.stringify(labels) === JSON.stringify([
    expectedUI("저자", "Authors"), expectedUI("연도", "Year"), expectedUI("저널", "Journal"),
  ]), labels);
  check(report, "sortLabelsFollowAppLanguage", inline.querySelector('[data-sort="relevance"]')?.textContent
    === expectedUI("정확도순", "Relevance")
    && inline.querySelector('[data-sort="dateAdded"]')?.textContent === expectedUI("최근 추가순 ↓", "Recently Added ↓"));
  check(report, "sortAccessibilityAndTitleFollowAppLanguage", inline.querySelector(".zcs-inline-sort")?.getAttribute("aria-label")
    === expectedUI("검색 결과 정렬", "Sort search results")
    && inline.querySelector('[data-sort="relevance"]')?.title
      === expectedUI("검색어 전체가 일치하는 문헌부터 표시", "Show complete query matches first"));
  check(report, "inlineSettingsAndActionsFollowAppLanguage", inline.querySelector(".zcs-inline-settings")?.textContent
    === expectedUI("인용 설정", "Citation Settings")
    && [...row.querySelectorAll("button")].some(button => button.textContent === expectedUI("긴 인용 복사", "Copy Long Citation"))
    && [...row.querySelectorAll("button")].some(button => button.textContent === expectedUI("서지목록에서 보기", "Show in Library")));
  const star = row.querySelector(".zcs-inline-star");
  check(report, "inlineFavoriteTooltipFollowsAppLanguage", star.title === expectedUI("즐겨찾기 추가", "Add to favorites")
    && star.getAttribute("aria-label") === star.title);
  check(report, "resultTitleTooltipFollowsAppLanguage", row.querySelector(".zcs-inline-title")?.title
    === expectedUI("첨부파일 열기 · 파일이 없으면 서지목록에서 보기", "Open attachment; show in library if no file is available"));
  check(report, "resultCountFollowsAppLanguage", inline.querySelector(".zcs-inline-count")?.textContent === expectedUI("1편", "1 result"));
  const fallbackClear = win.document.getElementById("zcs-search-clear");
  if (fallbackClear) check(report, "fallbackClearTooltipFollowsAppLanguage",
    fallbackClear.getAttribute("tooltiptext") === expectedUI("검색어 지우기", "Clear search")
    && fallbackClear.getAttribute("aria-label") === expectedUI("검색어 지우기", "Clear search"));
  checkEnglishUI(report, "inlineUiContainsNoKoreanInEnglish", [inline, fallbackClear]);
}

async function checkPreferencesLocalization({ report, prefDoc, paneID }) {
  const navigation = [...prefDoc.querySelectorAll("richlistitem")].find(node => node.value === paneID);
  const navigationLabel = navigation?.querySelector("label");
  check(report, "preferencesSidebarLabelFollowsAppLanguage", (navigationLabel?.value || navigationLabel?.textContent)
    === expectedUI("Context Search · 인용 설정", "Context Search · Citation settings"));
  const labels = {
    shortTitle: ["짧은 인용", "Short citations"],
    shortDescription: ["PPT에 붙여 넣을 인용에 필요한 정보를 선택하세요. 변경 사항은 바로 저장됩니다.", "Choose the information to include in citations for your slides. Changes save immediately."],
    number: ["번호 [1]", "Number [1]"], title: ["논문 제목", "Article title"],
    journal: ["저널명", "Journal"], volume: ["권", "Volume"], year: ["연도", "Year"], doi: ["DOI 링크", "DOI link"],
    authors: ["저자 표시", "Authors"], firstAuthor: ["첫 저자 + et al.", "First author + et al."], allAuthors: ["모든 저자", "All authors"],
    journalStyle: ["저널명 표시", "Journal name"],
    abbreviatedJournal: ["저장된 약칭 (없으면 전체 이름)", "Stored abbreviation (full name if unavailable)"], fullJournal: ["전체 이름", "Full name"],
    startNumber: ["시작 번호", "Starting number"],
    numberHelp: ["한 번에 여러 문헌을 복사하면 시작 번호부터 차례로 번호를 붙입니다.", "When copying several references, numbering begins at the starting number and continues in order."],
    preview: ["미리보기", "Preview"],
    exampleDescription: ["가상 문헌으로 양식을 미리 보여줍니다. 실제 복사에는 선택한 문헌의 서지정보가 사용됩니다.", "The preview uses a fictional reference. Copied citations use the metadata of your selected references."],
    longTitle: ["긴 인용", "Long citations"], format: ["사용할 양식", "Format"],
    nativeMode: ["Zotero의 빠른 복사 인용 스타일", "Zotero Quick Copy citation style"],
    customMode: ["짧은 인용 설정 + 모든 저자와 논문 제목", "Short citation settings + all authors and article title"],
    nativeDescription: ["저자, 제목, 번호, 구두점 등은 Zotero에서 선택한 스타일을 따릅니다. 위의 짧은 인용 설정은 적용하지 않습니다.", "Authors, titles, numbering, and punctuation follow the style selected in Zotero. The short citation settings above do not apply."],
    openExport: ["Zotero 빠른 복사 설정 열기", "Open Zotero Quick Copy settings"],
    customDescription: ["위의 짧은 인용 설정을 유지하면서 모든 저자와 논문 제목을 항상 포함합니다.", "Use the short citation settings above and always include all authors and the article title."],
    localSettings: ["인용 설정은 이 PC에 저장됩니다.", "Citation settings are saved on this computer."],
    reset: ["인용 설정을 기본값으로 되돌리기", "Restore default citation settings"],
  };
  const failures = [];
  for (const [key, values] of Object.entries(labels)) {
    const nodes = [...prefDoc.querySelectorAll(`[data-zcs-i18n="${key}"]`)];
    if (!nodes.length || nodes.some(node => node.textContent !== expectedUI(...values))) failures.push(key);
  }
  check(report, "allPreferenceLabelsAndOptionsFollowAppLanguage", failures.length === 0, failures);
  check(report, "preferenceFieldGroupAriaFollowsAppLanguage", prefDoc.querySelector(".zcs-citation-options")?.getAttribute("aria-label")
    === expectedUI("짧은 인용에 포함할 정보", "Fields included in short citations"));
  await waitFor(() => prefDoc.getElementById("zcs-citation-native-style")?.textContent
    .startsWith(expectedUI("현재 형식: ", "Current format: ")), 10000, "localized current citation style");
  check(report, "nativeCitationStyleStatusFollowsAppLanguage", true);
  checkEnglishUI(report, "nativePreferencesContainNoKoreanInEnglish",
    [navigation, ...[...prefDoc.querySelectorAll('[id^="zcs-citation-"]')].filter(node => node.localName === "groupbox")]);
}

async function runPluginChecks({ report, plugin, win, item, attachment, root }) {
  await waitFor(() => plugin.search?.search && plugin.favorites, 10000, "plugin modules");
  check(report, "pluginLoaded", true);
  const search = options => plugin.search.search({ libraryID: item.libraryID, ...options });
  let found = await search({ query: "sample", field: "fulltext" });
  const result = found.results.find(result => result.id === item.id);
  check(report, "fulltextResultMapsToParent", !!result, { total: found.total });
  const snippet = result.snippets.find(snippet => snippet.source === "pdf");
  check(report, "snippetContainsMatchingText", !!snippet && /sample/i.test(snippet.text), snippet);
  check(report, "snippetContainsBeforeAndAfterContext", snippet.text.includes("Before the match") && snippet.text.includes("After the match"));
  check(report, "snippetRetainsAttachmentLink", snippet.attachmentID === attachment.id);
  check(report, "snippetMarksLiteralHit", snippet.segments.some(segment => segment.match && /sample/i.test(segment.text)));
  found = await search({ query: '"example passage"', field: "fulltext" });
  check(report, "quotedPhraseFound", found.results.some(result => result.id === item.id));
  found = await search({ query: "absentword987654", field: "fulltext" });
  check(report, "nonmatchReturnsNoResults", found.total === 0);
  for (const [field, query] of [["title", "Example"], ["author", "Author"]]) {
    found = await search({ query, field });
    check(report, `${field}FilterFindsFixture`, found.results.some(result => result.id === item.id));
  }
  found = await search({ query: "sample", favoritesOnly: true, field: "fulltext" });
  check(report, "favoritesInitiallyEmpty", found.total === 0);

  item.addTag("demo-tag", 0);
  await item.saveTx();
  found = await search({ query: "demo-tag", field: "tags" });
  check(report, "tagFilterFindsFixture", found.results.some(result => result.id === item.id));
  await win.ZoteroPane.selectItem(item.id);
  report.nativeTree = {
    columnKey: plugin.favorites.columnKey,
    columns: win.ZoteroPane.itemsView.getColumns?.().map(column => ({ dataKey: column.dataKey, hidden: column.hidden, ordinal: column.ordinal })),
    rows: win.ZoteroPane.itemsView.rowCount,
    registeredWindows: plugin.favorites._windows?.size,
  };
  await IOUtils.writeUTF8(PathUtils.join(root, "native-tree.html"), win.document.getElementById("zotero-items-tree")?.outerHTML || "tree element missing");
  try {
  await waitFor(() => win.document.querySelector(`.zcs-favorite-button[data-item-id="${item.id}"]`), 5000, "actual favorite column cell");
  let starButton = win.document.querySelector(`.zcs-favorite-button[data-item-id="${item.id}"]`);
  check(report, "favoriteColumnRendersInNativeTree", starButton.textContent === "☆" && !starButton.disabled);
  const favoriteHeading = win.document.querySelector(".zcs-favorite-heading");
  check(report, "favoriteHeaderAndTooltipFollowAppLanguage", favoriteHeading?.getAttribute("title") === expectedUI("즐겨찾기", "Favorites")
    && starButton.title === expectedUI("즐겨찾기 추가", "Add to favorites")
    && starButton.getAttribute("aria-label") === starButton.title);
  checkEnglishUI(report, "nativeFavoriteUiContainsNoKoreanInEnglish", [favoriteHeading, starButton]);
  starButton.click();
  await waitFor(() => item.hasTag("★"), 10000, "favorite column click save");
  await waitFor(() => !plugin.favorites._pending?.has(item.id), 10000, "favorite save transaction");
  const persisted = await Zotero.DB.valueQueryAsync("SELECT COUNT(*) FROM itemTags JOIN tags USING (tagID) WHERE itemID=? AND name=?", [item.id, "★"]);
  check(report, "favoriteClickPersistsNormalTag", persisted === 1 || persisted === "1");
  check(report, "favoriteClickKeepsOtherTags", item.hasTag("demo-tag"));
  found = await search({ query: "sample", favoritesOnly: true, field: "fulltext" });
  check(report, "favoritesFilterFindsStarredPaper", found.results.some(result => result.id === item.id));
  starButton = win.document.querySelector(`.zcs-favorite-button[data-item-id="${item.id}"]`);
  await waitFor(() => starButton?.getAttribute("aria-pressed") === "true" && !starButton.disabled, 10000, "star cell repaint");
  check(report, "favoriteRemoveTooltipFollowsAppLanguage", starButton.title === expectedUI("즐겨찾기 해제", "Remove from favorites")
    && starButton.getAttribute("aria-label") === starButton.title);
  starButton.click();
  await waitFor(() => !item.hasTag("★"), 10000, "unstar save");
  await waitFor(() => !plugin.favorites._pending?.has(item.id), 10000, "unstar transaction");
  check(report, "favoriteClickCanRemoveStar", !item.hasTag("★"));
  item.addTag("⭐", 0);
  await item.saveTx();
  check(report, "OtherStarGlyphIsNotFavorite", !plugin.favorites.has(item));
  item.addTag("★", 0);
  await item.saveTx();
  check(report, "existingCanonicalStarRecognized", plugin.favorites.has(item));
  await plugin.favorites.toggle(item);
  check(report, "onlyCanonicalStarRemoved", !item.hasTag("★") && item.hasTag("⭐"));
  const view = win.ZoteroPane.itemsView;
  // Reorder through the same Columns manager used by a real header drag.
  // itemTree._getColumns() is separate from the manager's cloned columns.
  const originalColumns = view.tree._columns.getAsArray();
  const starIndex = originalColumns.findIndex(column => column.dataKey === plugin.favorites.columnKey);
  const originalSuccessor = originalColumns[starIndex + 1]?.dataKey;
  try {
    view.tree._columns.setOrder(starIndex, 0);
    const cell = await waitFor(() => {
      const button = win.document.querySelector(`.zcs-favorite-button[data-item-id="${item.id}"]`);
      return button?.closest(".cell")?.querySelector(".twisty") ? button.closest(".cell") : null;
    }, 5000, "native disclosure inside first favorite column");
    check(report, "favoriteCanBeFirstNativeColumn", cell.classList.contains("first-column")
      && !cell.classList.contains("clickable"));
    for (let click = 0; click < 2; click++) {
      const rowIndex = view.getSortedItems(true).indexOf(item.id);
      const wasOpen = view.isContainerOpen(rowIndex);
      const disclosure = win.document.querySelector(`.zcs-favorite-button[data-item-id="${item.id}"]`).closest(".cell").querySelector(".twisty");
      disclosure.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }));
      disclosure.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true, button: 0, detail: 1 }));
      disclosure.dispatchEvent(new win.MouseEvent("click", { bubbles: true, button: 0, detail: 1 }));
      await waitFor(() => view.isContainerOpen(view.getSortedItems(true).indexOf(item.id)) !== wasOpen, 5000, "native disclosure expansion/collapse");
      check(report, "disclosureDoesNotToggleFavorite:" + click, !item.hasTag("★"));
    }
    // A real star click must still work after native icons and the disclosure
    // arrow have been added to the same first cell.
    for (const starred of [true, false]) {
      const button = await waitFor(() => {
        const current = win.document.querySelector(`.zcs-favorite-button[data-item-id="${item.id}"]`);
        return current && !current.disabled ? current : null;
      }, 5000, "enabled first-column star");
      button.click();
      await waitFor(() => item.hasTag("★") === starred && !plugin.favorites._pending.has(item.id), 10000, "first-column favorite save");
      check(report, "firstColumnStarClick:" + starred, plugin.favorites.has(item) === starred);
    }
    await captureWindow(win, root, "first-column-favorites.png");
  }
  finally {
    const currentColumns = view.tree._columns.getAsArray();
    const currentStar = currentColumns.findIndex(column => column.dataKey === plugin.favorites.columnKey);
    const successor = originalSuccessor
      ? currentColumns.findIndex(column => column.dataKey === originalSuccessor) : currentColumns.length;
    view.tree._columns.setOrder(currentStar, successor);
  }
  }
  catch (error) {
    report.errors.push({ area: "nativeFavoritesColumn", message: String(error), stack: error.stack || "" });
    if (item.hasTag("★")) { item.removeTag("★"); await item.saveTx(); }
  }
  try {
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = win.innerWidth; canvas.height = win.innerHeight;
    canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
    const bytes = Uint8Array.from(win.atob(canvas.toDataURL("image/png").split(",")[1]), char => char.charCodeAt(0));
    await IOUtils.write(PathUtils.join(root, "native-library.png"), bytes);
    report.nativeScreenshot = PathUtils.join(root, "native-library.png");
  }
  catch (error) { report.nativeScreenshotError = String(error); }

  report.searchResult = result;
  check(report, "shortCitationFormat", plugin.citation.format(item)
    === "[1] S. Author et al., Fict. J. 1 (2024). https://doi.org/10.0000/example-article");
  // The production UI uses Zotero's native quick-search field in the main
  // window. Results replace the center list in place and the clear button
  // restores the native tree; no popup is required for this path.
  const quick = win.document.getElementById("zotero-tb-search");
  const inline = win.document.getElementById("zcs-inline-results");
  check(report, "inlineSearchUiInstalled", !!quick && !!inline);
  try {
    await IOUtils.writeUTF8(PathUtils.join(root, "quick-search-dom.html"),
      `${quick?.outerHTML || ""}\n---SEARCH---\n${quick?.searchTextbox?.outerHTML || ""}\n---SHADOW---\n${quick?.searchTextbox?.shadowRoot?.innerHTML || ""}`);
  }
  catch (_) {}
  quick.searchTextbox.value = "sample";
  quick.dispatchEvent(new win.Event("input", { bubbles: true }));
  await waitFor(() => win.document.querySelector("#zcs-inline-results .zcs-inline-row mark"), 15000, "inline context result");
  const inlineParagraph = win.document.querySelector("#zcs-inline-results .zcs-inline-snippet p");
  check(report, "inlineSearchRendersMatchingContext", !!inlineParagraph && inlineParagraph.textContent.includes("Before the match") && inlineParagraph.textContent.includes("After the match"));
  check(report, "inlineSearchHighlightsLiteralTerm", /sample/i.test(inlineParagraph?.querySelector("mark")?.textContent || ""));
  const metadataRow = inline.querySelector(".zcs-inline-row");
  check(report, "searchResultShowsTitleAuthorsYearAndJournal", metadataRow.querySelector(".zcs-inline-title").textContent === item.getField("title")
    && metadataRow.querySelector(".zcs-inline-authors").textContent === "Sample Author, Demo Writer"
    && metadataRow.querySelector(".zcs-inline-year").textContent === "2024"
    && metadataRow.querySelector(".zcs-inline-publication").textContent === "Fictional Journal");
  check(report, "compactSearchHeaderWithoutPluginIcon", inline.querySelector(".zcs-inline-head strong")?.textContent === expectedUI("전체 검색", "Full Search")
    && !inline.querySelector(".zcs-inline-head img") && inline.querySelector(".zcs-inline-head").getBoundingClientRect().height <= 44);
  checkInlineLocalization({ report, inline, win });
  check(report, "lightSearchBackgroundIsWhite", win.matchMedia("(prefers-color-scheme: dark)").matches
    || win.getComputedStyle(inline).backgroundColor === "rgb(255, 255, 255)");
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const addon = await AddonManager.getAddonByID("context-search@local.zotero");
  const pluginIcon = new win.Image();
  pluginIcon.src = addon.iconURL;
  await waitFor(() => pluginIcon.naturalWidth > 0, 10000, "plugin manager PNG icon");
  check(report, "pluginManagerRecognizesPackagedIcon", addon.iconURL.includes("icons/icon-"));
  const clearControl = quick.searchTextbox?.shadowRoot?.querySelector?.(".textbox-search-clear") || win.document.getElementById("zcs-search-clear");
  check(report, "inlineSearchShowsClearButton", !!clearControl);
  check(report, "inlineSearchHidesNativeTree", win.document.getElementById("zotero-items-tree").hidden === true);
  try {
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = win.innerWidth; canvas.height = win.innerHeight;
    canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
    const bytes = Uint8Array.from(win.atob(canvas.toDataURL("image/png").split(",")[1]), char => char.charCodeAt(0));
    await IOUtils.write(PathUtils.join(root, "inline-search.png"), bytes);
    report.inlineScreenshot = PathUtils.join(root, "inline-search.png");
  }
  catch (error) { report.inlineScreenshotError = String(error); }
  clearControl.click();
  await waitFor(() => !win.document.getElementById("zotero-items-tree").hidden && win.document.getElementById("zcs-inline-results").hidden, 10000, "native tree restored after clear");
  check(report, "inlineSearchClearRestoresNativeList", true);

  check(report, "clearRestoresNativeRows", win.ZoteroPane.itemsView.getSortedItems(true).includes(item.id));
  check(report, "inlineHostActuallyHiddenAfterClear", win.getComputedStyle(inline).display === "none");
  check(report, "popupLauncherRemoved", !plugin.openSearch && !win.document.getElementById("zcs-open-button"));
  const query = async text => {
    quick.searchTextbox.value = text;
    quick.dispatchEvent(new win.Event("input", { bubbles: true }));
    await waitFor(() => inline.querySelector(".zcs-inline-head") && !inline.querySelector(".zcs-inline-loading"), 15000, "completed inline query " + text);
    // Awaiting DOM headings alone can observe previous results before debounce.
    await new Promise(resolve => setTimeout(resolve, 700));
    await waitFor(() => inline.querySelector(".zcs-inline-head"), 15000, "settled inline query");
  };
  await query("sample");
  const article = inline.querySelector(".zcs-inline-row");
  check(report, "searchResultShortCitationActionVisible", [...article.querySelectorAll("button")].some(button => button.textContent === expectedUI("짧은 인용 복사", "Copy Short Citation")));
  const resultStar = article.querySelector(".zcs-inline-star");
  resultStar.click();
  await waitFor(() => item.hasTag("★") && !plugin.favorites._pending?.has(item.id), 10000, "search result favorite click");
  check(report, "searchResultStarUpdatesCanonicalTag", true);
  await query('"example passage"');
  check(report, "quotedPhraseRunsWithoutEnter", !!inline.querySelector(".zcs-inline-snippet mark"));
  for (const text of ["Example", "Author", "demo-tag"]) {
    await query(text);
    check(report, "inlineMetadataQuery:" + text, !!inline.querySelector(`[data-item-id="${item.id}"]`));
  }
  quick.searchTextbox.value = "sample";
  quick.dispatchEvent(new win.Event("input", { bubbles: true }));
  await query("absentword987654");
  check(report, "rapidTypingNeverRestoresOldResults", !inline.querySelector(".zcs-inline-row"));
  check(report, "emptyResultsFollowAppLanguage", inline.querySelector(".zcs-inline-empty strong")?.textContent
    === expectedUI("검색 결과가 없습니다", "No results"));
  checkEnglishUI(report, "emptyResultsContainNoKoreanInEnglish", [inline]);
  quick.searchTextbox.value = "";
  quick.dispatchEvent(new win.Event("input", { bubbles: true }));
  await waitFor(() => inline.hidden && win.ZoteroPane.itemsView.getSortedItems(true).includes(item.id), 10000, "backspace clear");
  check(report, "backspaceClearRestoresRows", true);

  const collection = new Zotero.Collection();
  collection.name = "Demo collection";
  await collection.saveTx();
  item.addToCollection(collection.id); await item.saveTx();
  const outside = new Zotero.Item("journalArticle");
  outside.setField("title", "Example outside collection");
  await outside.saveTx();
  await win.ZoteroPane.collectionsView.selectCollection(collection.id);
  await query("Example");
  check(report, "inlinePreservesCollectionScope", inline.querySelectorAll(".zcs-inline-row").length === 1 && !!inline.querySelector(`[data-item-id="${item.id}"]`));
  await plugin.inlineWindows.get(win).clearSearch();
  check(report, "clearKeepsCollectionScope", !win.ZoteroPane.itemsView.getSortedItems(true).includes(outside.id));
  await query("sample");
  [...inline.querySelectorAll("button")].find(button => button.textContent === expectedUI("서지목록에서 보기", "Show in Library")).click();
  await waitFor(() => inline.hidden && win.ZoteroPane.itemsView.getSelectedItems(true).includes(item.id), 10000, "view bibliographic item");
  check(report, "viewItemKeepsCollectionAndClearsQuery", !quick.value && !win.ZoteroPane.itemsView.getSortedItems(true).includes(outside.id));
  await captureWindow(win, root, "native-restored.png");

  // Capture the copy boundary inside the isolated process; never read or write
  // the real operating-system clipboard in automated tests.
  const originalCopy = Zotero.Utilities.Internal.copyTextToClipboard;
  let copied;
  Zotero.Utilities.Internal.copyTextToClipboard = text => { copied = text; };
  try {
    await win.ZoteroPane.buildItemContextMenu();
    const menu = win.document.querySelector('[data-l10n-id="zcs-copy-citation"]');
    check(report, "nativeRightClickCitationMenuExists", !!menu && !menu.disabled);
    menu.dispatchEvent(new win.Event("command", { bubbles: true }));
    await waitFor(() => copied, 5000, "native citation menu command");
    check(report, "nativeMenuCopiesNumberedCitation", copied === plugin.citation.format(item));
    copied = null;
    await query("sample");
    [...inline.querySelectorAll("button")].find(button => button.textContent === expectedUI("짧은 인용 복사", "Copy Short Citation")).click();
    await waitFor(() => copied, 5000, "inline copy action");
    check(report, "inlineCopyUsesSameNumberedCitation", copied === plugin.citation.format(item));
    check(report, "copyFeedbackFollowsAppLanguage", [...inline.querySelectorAll("button")]
      .some(button => button.textContent === expectedUI("복사됨 ✓", "Copied ✓")));
    await plugin.citation.copy([attachment.id, item.id, outside.id]);
    check(report, "multiCopyNumbersAndDeduplicatesParents", copied.split("\n").length === 2 && copied.startsWith("[1] ") && copied.includes("\n[2] "));
    const longMenu = win.document.querySelector('[data-l10n-id="zcs-copy-long-citation"]');
    const fileMenu = win.document.querySelector('[data-l10n-id="zcs-copy-original-file"]');
    check(report, "copyMenusAppearInRequestedOrder", !!longMenu && !!fileMenu
      && !!(menu.compareDocumentPosition(longMenu) & win.Node.DOCUMENT_POSITION_FOLLOWING)
      && !!(longMenu.compareDocumentPosition(fileMenu) & win.Node.DOCUMENT_POSITION_FOLLOWING));
    await win.document.l10n.translateElements([menu, longMenu, fileMenu]);
    check(report, "allNativeContextMenuLabelsFollowAppLanguage",
      menu.getAttribute("label") === expectedUI("짧은 인용 복사 (PPT)", "Copy Short Citation (PPT)")
      && longMenu.getAttribute("label") === expectedUI("긴 인용 복사", "Copy Long Citation")
      && fileMenu.getAttribute("label") === expectedUI("원본 파일 복사", "Copy Original File"),
      [menu, longMenu, fileMenu].map(node => node.getAttribute("label")));
    checkEnglishUI(report, "nativeCopyMenusContainNoKoreanInEnglish", [menu, longMenu, fileMenu]);

    const prefWindow = Zotero.Utilities.Internal.openPreferences(plugin.preferences.paneID);
    try {
      await waitFor(() => prefWindow.document.getElementById("zcs-citation-short-preview")?.textContent.includes("[1]"), 15000, "citation preferences loaded with live preview");
      const prefDoc = prefWindow.document;
      await checkPreferencesLocalization({ report, prefDoc, paneID: plugin.preferences.paneID });
      const start = prefDoc.getElementById("zcs-citation-start-number");
      start.value = "0"; start.dispatchEvent(new prefWindow.Event("input", { bubbles: true }));
      check(report, "preferencesValidationFollowsAppLanguage", start.getAttribute("aria-invalid") === "true"
        && prefDoc.getElementById("zcs-citation-save-status").textContent
          === expectedUI("시작 번호는 1 이상의 정수로 입력해 주세요.", "Enter a whole starting number of at least 1."));
      start.value = "7"; start.dispatchEvent(new prefWindow.Event("input", { bubbles: true }));
      prefDoc.querySelector('[data-zcs-citation-option="doi"]').click();
      check(report, "preferencesSaveAndUpdatePreview", plugin.preferences.getOptions("short").startNumber === 7
        && !plugin.preferences.getOptions("short").doi
        && prefDoc.getElementById("zcs-citation-short-preview").textContent.startsWith("[7]"));
      check(report, "preferencesSavedStatusFollowsAppLanguage", prefDoc.getElementById("zcs-citation-save-status").textContent
        === expectedUI("변경한 설정을 이 PC에 저장했습니다.", "Changes saved on this computer."));
      const mode = prefDoc.getElementById("zcs-citation-long-mode");
      mode.value = "custom"; mode.dispatchEvent(new prefWindow.Event("change", { bubbles: true }));
      check(report, "longCustomPreviewHasTitleAndAllAuthors", prefDoc.getElementById("zcs-citation-long-preview").textContent.includes("D. Writer")
        && prefDoc.getElementById("zcs-citation-long-preview").textContent.includes("Example research article"));
      copied = null;
      longMenu.dispatchEvent(new win.Event("command", { bubbles: true }));
      await waitFor(() => copied, 5000, "custom long citation menu");
      check(report, "longMenuCopiesInheritedFormat", copied.startsWith("[7] S. Author, D. Writer,")
        && copied.includes(item.getField("title")) && !copied.includes("doi.org"));
      checkEnglishUI(report, "customPreferencesContainNoKoreanInEnglish",
        [...prefDoc.querySelectorAll('[id^="zcs-citation-"]')].filter(node => node.localName === "groupbox"));
      await captureWindow(prefWindow, root, "citation-settings.png");
      prefDoc.getElementById("zcs-citation-reset").click();
      check(report, "preferencesResetStatusFollowsAppLanguage", prefDoc.getElementById("zcs-citation-save-status").textContent
        === expectedUI("기본 인용 설정으로 되돌렸습니다.", "Default citation settings restored."));
    }
    finally { prefWindow.close(); }

    const oldNativeCopy = win.Zotero_File_Interface.copyItemsToClipboard;
    let nativeCall;
    win.Zotero_File_Interface.copyItemsToClipboard = (...args) => { nativeCall = args; };
    try {
      await win.ZoteroPane.buildItemContextMenu();
      win.document.querySelector('[data-l10n-id="zcs-copy-long-citation"]').dispatchEvent(new win.Event("command", { bubbles: true }));
      await waitFor(() => nativeCall, 5000, "native long citation menu");
      const configured = Zotero.QuickCopy.unserializeSetting(Zotero.Prefs.get("export.quickCopy.setting"));
      check(report, "longMenuUsesConfiguredZoteroStyle", nativeCall[1] === configured.id && nativeCall[4] === false);
      const content = Zotero.QuickCopy.getContentFromItems([item], configured, null, false);
      // The default English Chicago style title-cases the article title, while
      // the Korean locale keeps its stored case. Both are valid CSL output.
      check(report, "nativeCslRendersFullBibliography", /example research article/i.test(content.text)
        && content.text.includes("Fictional Journal") && content.html.includes("2024")
        && content.html.includes('class="csl-bib-body"'),
        { configured, text: String(content.text).slice(0, 2000), html: String(content.html).slice(0, 2000) });
    }
    finally { win.Zotero_File_Interface.copyItemsToClipboard = oldNativeCopy; }

    const originalServices = plugin.fileCopy.Services;
    let transfer;
    plugin.fileCopy.Services = { clipboard: { kGlobalClipboard: 1, setData: value => { transfer = value; } } };
    try {
      win.document.querySelector('[data-l10n-id="zcs-copy-original-file"]').dispatchEvent(new win.Event("command", { bubbles: true }));
      await waitFor(() => transfer, 5000, "file copy menu builds native transferable");
      const payload = {};
      transfer.getTransferData("application/x-moz-file", payload);
      const actualFile = payload.value.QueryInterface(Ci.nsIFile);
      check(report, "originalFileCopyContainsActualFile", actualFile.path === await attachment.getFilePathAsync());
    }
    finally { plugin.fileCopy.Services = originalServices; }
    if (Zotero.isWin) {
      const api = plugin.fileCopy._openWindowsAPI();
      let handle;
      try {
        handle = api.allocate(plugin.fileCopy.constructor.makeDropFiles([await attachment.getFilePathAsync()]));
        check(report, "multiFileWindowsPayloadAllocatesWithoutClipboardAccess", !!handle && !handle.isNull());
      }
      finally { if (handle) api.free(handle); api.dispose(); }
    }
  }
  finally { Zotero.Utilities.Internal.copyTextToClipboard = originalCopy; }
  const pdfButton = [...inline.querySelectorAll("button")].find(button => button.textContent === expectedUI("PDF 열기 ↗", "Open PDF ↗"));
  check(report, "searchResultHasPdfAction", !!pdfButton);
  pdfButton.click();
  await waitFor(() => Zotero.Reader._readers?.some(reader => reader.itemID === attachment.id || reader._item?.id === attachment.id), 15000, "real PDF reader opens fixture");
  check(report, "searchResultOpensRealPdfReader", true);
  win.Zotero_Tabs.select("zotero-pane");
  await plugin.inlineWindows.get(win).clearSearch();
  for (let index = 1; index <= 43; index++) {
    const pageItem = new Zotero.Item("journalArticle");
    pageItem.setField("title", "PaginationFixture " + String(index).padStart(2, "0"));
    pageItem.addToCollection(collection.id);
    await pageItem.saveTx();
  }
  await query("PaginationFixture");
  check(report, "firstInlinePageIsBounded", inline.querySelectorAll(".zcs-inline-row").length === 40 && !!inline.querySelector(".zcs-inline-more"));
  check(report, "paginationLabelFollowsAppLanguage", inline.querySelector(".zcs-inline-more").textContent
    === expectedUI("더 보기 (40 / 43)", "Load More (40 / 43)"));
  checkEnglishUI(report, "paginatedUiContainsNoKoreanInEnglish", [inline]);
  inline.querySelector(".zcs-inline-more").click();
  await waitFor(() => inline.querySelectorAll(".zcs-inline-row").length === 43, 15000, "second inline page");
  check(report, "loadMoreIncludesEveryMatch", !inline.querySelector(".zcs-inline-more"));
  await query("sample");
  await win.ZoteroPane.itemsView.setFilter("tags", new Set(["missing-tag"]));
  await waitFor(() => inline.querySelector(".zcs-inline-empty"), 15000, "tag filter changes during search");
  check(report, "tagChangeRefreshesScopedResults", !inline.querySelector(".zcs-inline-row"));
  await win.ZoteroPane.itemsView.setFilter("tags", new Set());
  await waitFor(() => inline.querySelector(".zcs-inline-row"), 15000, "tag scope restored");
  // Pause document enrichment after matching, then change scope before it
  // finishes. The old scoped result must be cancelled and refreshed.
  const originalPresent = plugin.search.presentNativeResults;
  let releasePage;
  let holdOnce = true;
  plugin.search.presentNativeResults = async function (options) {
    if (holdOnce) {
      holdOnce = false;
      await new Promise(resolve => { releasePage = resolve; });
    }
    return originalPresent.call(this, options);
  };
  try {
    quick.searchTextbox.value = "Example";
    quick.dispatchEvent(new win.Event("input", { bubbles: true }));
    await waitFor(() => releasePage, 10000, "enrichment paused");
    await win.ZoteroPane.itemsView.setFilter("tags", new Set(["missing-tag"]));
    releasePage();
    await waitFor(() => inline.querySelector(".zcs-inline-empty"), 15000, "changed scope supersedes running query");
    check(report, "scopeChangeDuringEnrichmentCancelsStalePage", !inline.querySelector(".zcs-inline-row"));
  }
  finally {
    releasePage?.();
    plugin.search.presentNativeResults = originalPresent;
  }
  await win.ZoteroPane.itemsView.setFilter("tags", new Set());
  await plugin.inlineWindows.get(win).clearSearch();
  const rankCollection = new Zotero.Collection();
  rankCollection.name = "Search examples";
  await rankCollection.saveTx();
  const rankedFixtures = [];
  for (const title of ["Sample notes on reference browsing", "Example research article", "Sample Phrase in a fictional article"]) {
    const fixture = new Zotero.Item("journalArticle");
    fixture.setField("title", title);
    fixture.setField("abstractNote", "A phrase appears as a separate keyword in this fictional abstract.");
    fixture.setField("date", ["2001", "2025", "2024"][rankedFixtures.length]);
    fixture.setField("dateAdded", ["2025-03-01 12:00:00", "2025-01-01 12:00:00", "2025-02-01 12:00:00"][rankedFixtures.length]);
    fixture.setField("publicationTitle", "Fictional Journal");
    fixture.setCreators([{ firstName: "Sample", lastName: "Author", creatorType: "author" }]);
    fixture.addToCollection(rankCollection.id);
    await fixture.saveTx();
    rankedFixtures.push(fixture);
  }
  const phraseAttachment = await Zotero.Attachments.importFromFile({
    file: PathUtils.join(root, "fixture-phrase.pdf"), parentItemID: rankedFixtures[1].id,
  });
  await Zotero.FullText.indexItems([phraseAttachment.id], { complete: true });
  await win.ZoteroPane.collectionsView.selectCollection(rankCollection.id);
  await query("Sample Phrase");
  await waitFor(() => inline.querySelectorAll(".zcs-inline-row").length === 3, 15000, "ranked phrase fixtures");
  const orderedIDs = [...inline.querySelectorAll(".zcs-inline-row")].map(row => Number(row.dataset.itemId));
  check(report, "exactTitleThenBodyPhraseBeforePartialTitle", JSON.stringify(orderedIDs) === JSON.stringify([rankedFixtures[2].id, rankedFixtures[1].id, rankedFixtures[0].id]), orderedIDs);
  const phraseRow = inline.querySelector(`[data-item-id="${rankedFixtures[1].id}"]`);
  check(report, "laterFullPhraseIsFirstSnippet", phraseRow.querySelector(".zcs-inline-snippet p").textContent.includes("Sample Phrase"));
  check(report, "rankedSearchKeepsCollectionScope", !inline.querySelector(`[data-item-id="${item.id}"]`));
  await captureWindow(win, root, "ranked-search.png");
  const orderIs = expected => JSON.stringify([...inline.querySelectorAll(".zcs-inline-row")].map(row => Number(row.dataset.itemId)))
    === JSON.stringify(expected.map(fixture => fixture.id));
  inline.querySelector('[data-sort="dateAdded"]').click();
  await waitFor(() => inline.querySelector('[data-sort="dateAdded"]')?.getAttribute("aria-pressed") === "true"
    && orderIs([rankedFixtures[0], rankedFixtures[2], rankedFixtures[1]]), 15000, "newest added order");
  check(report, "recentAddedUsesParentAdditionDate", true);
  check(report, "sortKeepsQueryAndCollectionScope", quick.value === "Sample Phrase" && inline.querySelectorAll(".zcs-inline-row").length === 3);
  inline.querySelector('[data-sort="dateAdded"]').click();
  await waitFor(() => inline.querySelector('[data-sort="dateAdded"]')?.textContent === expectedUI("오래된 추가순 ↑", "Oldest Added ↑")
    && orderIs([rankedFixtures[1], rankedFixtures[2], rankedFixtures[0]]), 15000, "oldest added order");
  check(report, "addedOrderButtonTogglesToOldest", true);
  await query("Sample");
  check(report, "newQueryKeepsChosenSort", orderIs([rankedFixtures[1], rankedFixtures[2], rankedFixtures[0]])
    && Zotero.Prefs.get("contextSearch.sortMode") === "dateAddedAsc");
  inline.querySelector('[data-sort="relevance"]').click();
  await waitFor(() => inline.querySelector('[data-sort="relevance"]')?.getAttribute("aria-pressed") === "true", 15000, "relevance sort restored");
  await query("Sample Phrase");
  check(report, "relevanceButtonRestoresExactPhraseOrder", orderIs([rankedFixtures[2], rankedFixtures[1], rankedFixtures[0]]));
  await plugin.inlineWindows.get(win).clearSearch();
  await win.ZoteroPane.collectionsView.selectCollection(collection.id);
  await query("sample");
  await captureWindow(win, root, "inline-search.png");
  await checkWrappedTitleLayout({ report, plugin, win, root, item });
  await checkResultNavigation({ report, plugin, win, root, query, restoreCollection: collection });
  await checkPdfPageNavigation({ report, plugin, win, root, query, item, attachment });
  const testUI = plugin.inlineWindows.get(win);
  testUI.renderLoading("sample");
  check(report, "loadingMessageFollowsAppLanguage", inline.querySelector(".zcs-inline-loading")?.textContent
    === expectedUI("‘sample’ 검색 중…", "Searching for “sample”…"));
  checkEnglishUI(report, "loadingUiContainsNoKoreanInEnglish", [inline]);
  testUI.renderError();
  check(report, "errorMessageFollowsAppLanguage", inline.querySelector(".zcs-inline-empty strong")?.textContent
    === expectedUI("검색을 완료하지 못했습니다", "Search could not be completed"));
  checkEnglishUI(report, "errorUiContainsNoKoreanInEnglish", [inline]);
  await query("sample");
  await captureWindow(win, root, "inline-search.png");
  // Destruction while a query is active restores the ordinary field/list.
  await plugin.destroy();
  check(report, "disableRemovesInlineUiAndRestoresTree", !win.document.getElementById("zcs-inline-results") && !win.document.getElementById("zcs-search-clear") && !win.document.getElementById("zotero-items-tree").hidden);
  await win.ZoteroPane.clearQuicksearch();
  check(report, "nativeSearchStillWorksAfterDisable", win.ZoteroPane.itemsView.getSortedItems(true).includes(item.id));
}

async function checkWrappedTitleLayout({ report, plugin, win, root, item }) {
  const ui = plugin.inlineWindows.get(win);
  const host = ui.host;
  const previousStyle = host.getAttribute("style");
  const fixture = {
    ...report.searchResult,
    id: item.id,
    title: "Example research article with a deliberately long sample title for checking line wrapping, author spacing, and publication details across different library window sizes",
    creators: "Sample Author, Demo Writer, Example Researcher, Fictional Editor, Test Contributor, Placeholder Reviewer",
    year: "2023", publication: "Fictional Journal", tags: [], snippets: [],
  };
  const measurements = [];
  try {
    for (const [width, fontSize] of [[320, 15], [440, 15], [320, 20]]) {
      host.style.width = `${width}px`;
      host.style.maxWidth = `${width}px`;
      host.style.flex = "none";
      ui.render({ total: 1, results: [fixture] }, "sample");
      const title = host.querySelector(".zcs-inline-title");
      title.style.fontSize = `${fontSize}px`;
      await settleLayout(win);
      const range = win.document.createRange();
      range.selectNodeContents(title);
      const textRects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
      const textBottom = Math.max(...textRects.map(rect => rect.bottom));
      const box = title.getBoundingClientRect();
      const authors = host.querySelector(".zcs-inline-authors").getBoundingClientRect();
      const year = host.querySelector(".zcs-inline-publication-line").getBoundingClientRect();
      const content = host.querySelector(".zcs-inline-content").getBoundingClientRect();
      const style = win.getComputedStyle(title);
      const measurement = {
        width, fontSize, titleHeight: box.height, textBottom,
        titleBottom: box.bottom, authorsTop: authors.top, authorsBottom: authors.bottom,
        yearTop: year.top, nativeMaxHeight: style.maxHeight,
        lineCount: new Set(textRects.map(rect => Math.round(rect.top))).size,
      };
      measurements.push(measurement);
      await IOUtils.writeUTF8(PathUtils.join(root, "wrapped-title-layout.json"), JSON.stringify(measurements, null, 2));
      await captureWindow(win, root, `wrapped-title-${width}-${fontSize}.png`);
      check(report, `wrappedTitleContainsEveryLine:${width}:${fontSize}`,
        measurement.lineCount >= 2 && textBottom <= box.bottom + 1
        && textRects.every(rect => rect.left >= content.left - 1 && rect.right <= content.right + 1), measurement);
      check(report, `wrappedTitleKeepsMetadataBelow:${width}:${fontSize}`,
        authors.top >= textBottom + 6 && year.top >= authors.bottom + 2, measurement);
    }
    let openedResult, openedWindow;
    const originalOpen = plugin.openResultFile;
    plugin.openResultFile = async (result, resultWindow) => { openedResult = result; openedWindow = resultWindow; };
    try {
      host.querySelector(".zcs-inline-title").click();
      check(report, "wrappedTitleRetainsFileNavigation", openedResult === fixture && openedWindow === win);
    }
    finally { plugin.openResultFile = originalOpen; }
  }
  finally {
    if (previousStyle === null) host.removeAttribute("style");
    else host.setAttribute("style", previousStyle);
  }
}

async function checkResultNavigation({ report, plugin, win, root, query, restoreCollection }) {
  const pane = win.ZoteroPane;
  const ui = plugin.inlineWindows.get(win);
  const inline = ui.host;
  const quick = win.document.getElementById("zotero-tb-search");
  const settle = () => settleLayout(win);
  const phases = [];
  const progress = async phase => {
    phases.push({ phase, time: new Date().toISOString(), checks: report.checks.length });
    await IOUtils.writeUTF8(PathUtils.join(root, "navigation-progress.json"), JSON.stringify(phases, null, 2));
  };
  await progress("start");
  const testCollection = new Zotero.Collection();
  testCollection.name = "Navigation examples";
  await testCollection.saveTx();
  await progress("collectionCreated");
  // Keep these fixtures after pagination/ranking checks so their candidate
  // counts stay independent. A middle row has room below to align at the top.
  await Zotero.DB.executeTransaction(async () => {
    for (let index = 1; index <= 80; index++) {
      const fixture = new Zotero.Item("journalArticle");
      fixture.setField("title", "Navigation fixture " + String(index).padStart(3, "0"));
      fixture.addToCollection(testCollection.id);
      await fixture.save();
    }
  });
  await progress("fixturesSaved");
  await ui.clearSearch();
  await progress("searchCleared");
  await pane.collectionsView.selectCollection(testCollection.id);
  await progress("collectionSelected");
  await pane.itemsView.waitForLoad();
  await progress("itemViewLoaded");
  try {
    const view = pane.itemsView;
    const originalOrder = view.getSortedItems(true);
    const target = await Zotero.Items.getAsync(originalOrder[30]);
    const targetIndex = view.getRowIndexByID(target.id);
    const originalSort = { field: view.getSortField(), direction: view.getSortDirection() };
    const originalCollection = pane.collectionsView.selectedTreeRow.id;
    const box = view._treebox;
    box.scrollTo(box._getItemPosition(targetIndex - 3));
    await settle();
    await progress("middleRowVisible");
    check(report, "navigationFixtureStartsScrolledWithMiddleRowVisible",
      originalOrder.length === 80 && targetIndex === 30
      && box.getFirstVisibleRow() === targetIndex - 3
      && box.getLastVisibleRow() >= targetIndex);

    await query(target.getField("title"));
    await progress("middleQueryComplete");
    const resultRow = await waitFor(() => inline.querySelector(`[data-item-id="${target.id}"]`), 10000, "middle bibliographic result");
    [...resultRow.querySelectorAll("button")].find(button => button.textContent === expectedUI("서지목록에서 보기", "Show in Library")).click();
    await waitFor(() => inline.hidden && view.getSelectedItems(true).includes(target.id), 10000, "middle native row selected");
    await progress("nativeTargetSelected");
    await waitFor(() => view._treebox.getFirstVisibleRow() === targetIndex, 10000, "selected native row aligned at viewport top");
    await settle();
    const scrollDetail = { targetIndex, firstVisible: view._treebox.getFirstVisibleRow(),
      actualOffset: view._treebox.targetElement.scrollTop, expectedOffset: view._treebox._getItemPosition(targetIndex) };
    check(report, "viewItemAlignsMiddleNativeRowAtTop", !quick.value
      && scrollDetail.firstVisible === targetIndex
      && Math.abs(scrollDetail.actualOffset - scrollDetail.expectedOffset) <= 1, scrollDetail);
    check(report, "viewItemPreservesNativeOrderSortAndCollection",
      JSON.stringify(view.getSortedItems(true)) === JSON.stringify(originalOrder)
      && view.getSortField() === originalSort.field && view.getSortDirection() === originalSort.direction
      && pane.collectionsView.selectedTreeRow.id === originalCollection);
    await captureWindow(win, root, "native-selected-top.png");
    await progress("selectedRowAligned");

    await query(target.getField("title"));
    const readersBefore = Zotero.Reader._readers.length;
    inline.querySelector(`[data-item-id="${target.id}"] .zcs-inline-title`).click();
    await waitFor(() => inline.hidden && !quick.value && view.getSelectedItems(true).includes(target.id), 10000, "title without a file selects the native item");
    check(report, "titleWithoutAttachmentFallsBackToNativeList", Zotero.Reader._readers.length === readersBefore
      && pane.collectionsView.selectedTreeRow.id === originalCollection);
    await progress("noAttachmentFallbackComplete");

    const firstPDF = await Zotero.Attachments.importFromFile({ file: PathUtils.join(root, "fixture.pdf"), parentItemID: target.id });
    firstPDF.setField("title", "First example attachment");
    await firstPDF.saveTx();
    const matchedPDF = await Zotero.Attachments.importFromFile({ file: PathUtils.join(root, "fixture-phrase.pdf"), parentItemID: target.id });
    matchedPDF.setField("title", "Matched example attachment");
    await matchedPDF.saveTx();
    await Zotero.FullText.indexItems([firstPDF.id, matchedPDF.id], { complete: true });
    await progress("pdfFixturesIndexed");
    await query("precise");
    await progress("matchingQueryComplete");
    const matchedRow = await waitFor(() => inline.querySelector(`[data-item-id="${target.id}"]`), 10000, "matched second PDF result");
    const matchedResult = ui.rows.get(target.id).result;
    const resultIDs = [...inline.querySelectorAll(".zcs-inline-row")].map(row => row.dataset.itemId);
    const preview = matchedRow.querySelector(".zcs-inline-snippet p").textContent;
    matchedRow.querySelector(".zcs-inline-title").click();
    const reader = await waitFor(() => {
      const selected = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      return selected?.itemID === matchedPDF.id ? selected : null;
    }, 15000, "title opens the matching second PDF in the real reader");
    await progress("matchedReaderOpened");
    check(report, "titleOpensMatchedPdfInsteadOfOtherAttachment",
      matchedResult.attachmentID === firstPDF.id
      && matchedResult.snippets.some(snippet => snippet.source === "pdf" && snippet.attachmentID === matchedPDF.id)
      && reader.itemID === matchedPDF.id
      && !Zotero.Reader._readers.some(openReader => openReader.itemID === firstPDF.id),
      { firstPDF: firstPDF.id, matchedPDF: matchedPDF.id, resultAttachment: matchedResult.attachmentID, opened: reader.itemID });
    win.Zotero_Tabs.select("zotero-pane");
    await settle();
    check(report, "returnFromTitlePdfKeepsQueryAndResults", quick.value === "precise" && !inline.hidden
      && win.document.getElementById("zotero-items-tree").hidden
      && JSON.stringify([...inline.querySelectorAll(".zcs-inline-row")].map(row => row.dataset.itemId)) === JSON.stringify(resultIDs)
      && inline.querySelector(`[data-item-id="${target.id}"] .zcs-inline-snippet p`).textContent === preview
      && pane.collectionsView.selectedTreeRow.id === originalCollection);
    await captureWindow(win, root, "title-pdf-return.png");
    await progress("returnComplete");
  }
  finally {
    await progress("restoreStarted");
    win.Zotero_Tabs.select("zotero-pane");
    await ui.clearSearch();
    await pane.collectionsView.selectCollection(restoreCollection.id);
    await progress("restored");
  }
}

async function checkPdfPageNavigation({ report, plugin, win, root, query, item, attachment }) {
  const ui = plugin.inlineWindows.get(win);
  const inline = ui.host;
  const quick = win.document.getElementById("zotero-tb-search");
  const fulltext = Zotero.Fulltext || Zotero.FullText;
  const pages = await fulltext.getPages(attachment.id);
  const pageStats = { indexedPages: pages.indexedPages, total: pages.total };
  const cacheFile = fulltext.getItemCacheFile(attachment);
  const cacheText = await Zotero.File.getContentsAsync(cacheFile.path || cacheFile);
  check(report, "nativePageFixtureHasVerifiedTwoPageCache", pages.indexedPages === 2
    && (cacheText.match(/\f/g) || []).length === 1, pageStats);

  let pageTwoButton;
  for (const [phrase, pageNumber] of [["example passage", 1], ["page boundary", 2]]) {
    await query(`"${phrase}"`);
    const row = await waitFor(() => inline.querySelector(`[data-item-id="${item.id}"]`), 10000, "numbered PDF result");
    const result = ui.rows.get(item.id).result;
    const button = row.querySelector(`.zcs-snippet-page[data-page-number="${pageNumber}"]`);
    check(report, "pdfSnippetLabelsVerifiedPage:" + pageNumber,
      !!button && !button.disabled && button.closest(".zcs-inline-source")
      && button.textContent === `PDF p. ${pageNumber}`
      && button.title === expectedUI(`PDF p. ${pageNumber} 열기`, `Open PDF at p. ${pageNumber}`)
      && button.getAttribute("aria-label") === button.title
      && result.snippets.some(snippet => snippet.source === "pdf" && snippet.attachmentID === attachment.id
        && snippet.pageNumber === pageNumber && snippet.endPageNumber === pageNumber));
    if (pageNumber === 2) pageTwoButton = button;
  }
  const beforeIDs = [...inline.querySelectorAll(".zcs-inline-row")].map(row => row.dataset.itemId);
  const beforePreview = inline.querySelector(`[data-item-id="${item.id}"] .zcs-inline-snippet p`).textContent;
  const originalOpen = Zotero.Reader.open;
  const calls = [];
  Zotero.Reader.open = function (itemID, location, options) {
    calls.push({ itemID, location });
    return originalOpen.call(this, itemID, location, options);
  };
  try {
    pageTwoButton.click();
    const reader = await waitFor(() => {
      const selected = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
      return selected?.itemID === attachment.id
        && selected._internalReader?._state?.primaryViewStats?.pageIndex === 1 ? selected : null;
    }, 15000, "page link opens the actual reader at PDF page two");
    check(report, "pageLinkOpensMatchingAttachmentAtPageIndexOne",
      calls.some(call => call.itemID === attachment.id && call.location?.pageIndex === 1)
      && reader._internalReader._state.primaryViewStats.pageIndex === 1);
    await captureWindow(win, root, "page-two-reader.png");
  }
  finally {
    Zotero.Reader.open = originalOpen;
    win.Zotero_Tabs.select("zotero-pane");
  }
  await settleLayout(win);
  check(report, "returnFromPageLinkKeepsQueryAndResults", quick.value === '"page boundary"' && !inline.hidden
    && JSON.stringify([...inline.querySelectorAll(".zcs-inline-row")].map(row => row.dataset.itemId)) === JSON.stringify(beforeIDs)
    && inline.querySelector(`[data-item-id="${item.id}"] .zcs-inline-snippet p`).textContent === beforePreview
    && !!inline.querySelector(`[data-item-id="${item.id}"] .zcs-snippet-page[data-page-number="2"]`));
  await captureWindow(win, root, "page-search.png");
  checkEnglishUI(report, "numberedPdfUiContainsNoKoreanInEnglish", [inline]);

  // A renderer-only fixture checks range typography independently from page
  // extraction. No click or claim about this two-page PDF having page 3/4.
  const pageResult = ui.rows.get(item.id).result;
  ui.render({ total: 1, results: [{ ...pageResult, snippets: [{
    source: "pdf", attachmentID: attachment.id, pageNumber: 3, endPageNumber: 4,
    text: "Cross-page sample phrase", segments: [{ text: "Cross-page sample phrase", match: true }],
  }] }] }, "sample");
  const rangeButton = inline.querySelector(".zcs-snippet-page");
  check(report, "pdfRangeLabelUsesInternationalPageNotation", rangeButton?.textContent === "PDF pp. 3–4"
    && rangeButton.title === expectedUI("PDF p. 3 열기", "Open PDF at p. 3")
    && rangeButton.getAttribute("aria-label") === rangeButton.title);

  // Change only the stats accessor for this synthetic attachment. The native
  // PDF/cache and stored page metadata stay intact, and the method is restored.
  const originalGetPages = fulltext.getPages;
  try {
    for (const [label, unavailable] of [["missing", null], ["mismatched", { ...pageStats, indexedPages: 99 }]]) {
      fulltext.getPages = function (id, ...args) {
        return id === attachment.id ? Promise.resolve(unavailable) : originalGetPages.call(this, id, ...args);
      };
      plugin.search.invalidate();
      await query('"page boundary"');
      const row = await waitFor(() => inline.querySelector(`[data-item-id="${item.id}"]`), 10000, "PDF context with unverified page stats");
      const snippets = ui.rows.get(item.id).result.snippets;
      check(report, "unverifiedPageStatsKeepContextWithoutPageLink:" + label,
        row.querySelector(".zcs-inline-snippet p")?.textContent.includes("page boundary")
        && !row.querySelector(".zcs-snippet-page")
        && snippets.every(snippet => snippet.pageNumber === undefined && snippet.endPageNumber === undefined));
      check(report, "unnumberedPdfSourceFollowsAppLanguage:" + label,
        row.querySelector(".zcs-inline-source span")?.textContent === expectedUI("PDF 본문", "PDF text"));
    }
  }
  finally {
    fulltext.getPages = originalGetPages;
    plugin.search.invalidate();
  }
}

async function settleLayout(win) {
  // Background windows can throttle animation frames for many seconds. These
  // checks need completed layout, which the geometry read flushes synchronously.
  await new Promise(resolve => win.setTimeout(resolve, 50));
  win.document.documentElement.getBoundingClientRect();
}

async function captureWindow(win, root, name) {
  const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = win.innerWidth; canvas.height = win.innerHeight;
  canvas.getContext("2d").drawWindow(win, 0, 0, canvas.width, canvas.height, "white");
  const bytes = Uint8Array.from(win.atob(canvas.toDataURL("image/png").split(",")[1]), char => char.charCodeAt(0));
  await IOUtils.write(PathUtils.join(root, name), bytes);
}
