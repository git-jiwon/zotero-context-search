/* UI language follows Zotero, independently of bibliographic data and CSL styles. */
var ZCSL10n = (() => {
  "use strict";

  function create({ Zotero, Services } = {}) {
    let applicationLocale;
    for (const read of [
      () => Zotero?.locale,
      () => Services?.locale?.appLocaleAsBCP47,
      () => Services?.locale?.appLocaleAsLangTag,
    ]) {
      try {
        const value = read();
        if (typeof value === "string" && value.trim()) { applicationLocale = value.trim(); break; }
      }
      catch (_) { /* Use the next application-locale source if unavailable. */ }
    }
    const isKorean = /^ko(?:[-_]|$)/i.test(applicationLocale || "");
    const locale = isKorean ? "ko-KR" : "en-US";
    const t = (ko, en, args = {}) => String(isKorean ? ko : en).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,
      (placeholder, key) => Object.hasOwn(args, key) ? String(args[key]) : placeholder);
    return Object.freeze({ locale, isKorean, t });
  }

  return { create };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZCSL10n;
