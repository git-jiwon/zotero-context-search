const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../addon/content/localization.js');

test('UI locale follows Zotero application locale before service fallbacks', () => {
  const service = { locale: { appLocaleAsBCP47: 'ko-KR', appLocaleAsLangTag: 'ko-KR' } };
  const english = create({ Zotero: { locale: 'en-GB' }, Services: service });
  assert.equal(english.locale, 'en-US');
  assert.equal(english.t('한국어', 'English'), 'English');
  for (const locale of ['ko', 'ko-KR', 'ko_KR', 'KO-kr']) {
    const korean = create({ Zotero: { locale }, Services: { locale: { appLocaleAsBCP47: 'en-US' } } });
    assert.equal(korean.locale, 'ko-KR');
    assert.equal(korean.t('한국어', 'English'), '한국어');
  }
});

test('missing application locale uses native services, then English for unsupported or unavailable locales', () => {
  const failing = { get locale() { throw new Error('Unavailable'); } };
  assert.equal(create({ Zotero: failing, Services: { locale: { appLocaleAsBCP47: 'ko-KR' } } }).locale, 'ko-KR');
  assert.equal(create({ Services: { locale: { appLocaleAsLangTag: 'ko-KR' } } }).locale, 'ko-KR');
  for (const locale of ['fr-FR', 'de-DE', 'en-US', 'invalid', '']) {
    assert.equal(create({ Zotero: { locale } }).locale, 'en-US');
  }
  assert.equal(create().locale, 'en-US');
});

test('translation parameters remain literal and never execute or recursively substitute', () => {
  const l10n = create({ Zotero: { locale: 'en-US' } });
  const value = '<script>{count}</script> $& 한글';
  assert.equal(l10n.t('', 'Query: {query}; {count}', { query: value, count: 2 }), `Query: ${value}; 2`);
  assert.equal(l10n.t('', '{missing}'), '{missing}');
  assert.equal(l10n.t('', '{inherited}', Object.create({ inherited: 'private' })), '{inherited}');
});
