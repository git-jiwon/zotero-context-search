/* global Zotero, Services, Cc, Ci, ChromeUtils */
"use strict";

var chromeHandle;
var pluginScope;
var controller;

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  const startupService = Cc["@mozilla.org/addons/addon-manager-startup;1"]
    .getService(Ci.amIAddonManagerStartup);
  chromeHandle = startupService.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "zotero-context-search", "content/"]
  ]);
  pluginScope = { Zotero, Services, ChromeUtils, Components: { classes: Cc, interfaces: Ci }, rootURI };
  for (const file of ["localization.js", "snippets.js", "search.js", "favorites.js", "preferences.js", "citation.js", "file-copy.js", "inline-ui.js", "controller.js"]) {
    Services.scriptloader.loadSubScript(rootURI + "content/" + file, pluginScope, "UTF-8");
  }
  controller = new pluginScope.ZCSController({
    Zotero, Services, rootURI, id, version,
    core: pluginScope.ZCSCore,
    Search: pluginScope.ZCSSearch,
    Favorites: pluginScope.ZCSFavorites,
    Citation: pluginScope.ZCSCitation,
    Preferences: pluginScope.ZCSCitationPreferences,
    FileCopy: pluginScope.ZCSFileCopy,
    InlineUI: pluginScope.ZCSInlineUI
  });
  Zotero.ContextSearchPlugin = controller;
  try {
    await controller.init();
  }
  catch (error) {
    await shutdown();
    Zotero.logError(error);
    throw error;
  }
}

function onMainWindowLoad({ window }) {
  controller?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  controller?.removeFromWindow(window);
}

async function shutdown() {
  if (controller) {
    await controller.destroy();
    if (Zotero.ContextSearchPlugin === controller) delete Zotero.ContextSearchPlugin;
  }
  controller = null;
  pluginScope = null;
  chromeHandle?.destruct();
  chromeHandle = null;
}

function install() {}
function uninstall() {}
