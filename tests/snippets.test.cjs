const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../addon/content/snippets.js');
const { spawnSync } = require('node:child_process');

test('finds actual matching context deep in a document, not its opening paragraph', () => {
  const text = 'Unrelated introduction. '.repeat(3000) + 'Previous sentence. The capacitance changes under load. Following sentence.';
  const [snippet] = core.findSnippets(text, 'capacitance');
  assert.match(snippet.text, /Previous sentence\. The capacitance changes under load\. Following sentence\./);
  assert.ok(snippet.segments.some(part => part.match && part.text === 'capacitance'));
  assert.ok(snippet.text.length < 560);
});

test('Korean, composed Unicode, accents, whitespace and line-end hyphenation', () => {
  assert.ok(core.findSnippets('실험 결과입니다. 저장 전하량이 증가했다. 결론입니다.', '전하량')[0].segments.some(part => part.match && part.text === '전하량'));
  assert.ok(core.matchesText('CAFÉ energy', 'cafe'));
  assert.ok(core.matchesText('tribo-\nelectric output', 'triboelectric'));
  assert.ok(core.matchesText('decision–making improves', '"decision making"'));
  assert.ok(core.matchesText('stored\n\tcharge density', '"stored charge"'));
});

test('literal punctuation and HTML-looking text never become expressions or markup', () => {
  const text = 'Before. An <img src=x onerror=alert(1)> string and C++ are examples. After.';
  const [snippet] = core.findSnippets(text, '"<img src=x onerror=alert(1)>"');
  assert.ok(snippet.segments.some(part => part.match && part.text === '<img src=x onerror=alert(1)>'));
  assert.equal(snippet.segments.map(part => part.text).join(''), snippet.text);
  assert.ok(core.matchesText(text, 'C++'));
  assert.equal(core.matchesText('CCCC', 'C++'), false);
  assert.equal(core.matchesText('anything', '.*'), false);
});

test('phrases remain contiguous; no fabricated excerpt for a miss', () => {
  assert.deepEqual(core.parseQuery('alpha "stored charge" 전하'), [
    { text: 'alpha', inQuotes: false }, { text: 'stored charge', inQuotes: true }, { text: '전하', inQuotes: false },
  ]);
  assert.deepEqual(core.findSnippets('Stored separately with no charge relationship.', '"stored charge"'), []);
  assert.deepEqual(core.findSnippets('No relevant terms.', 'capacitor'), []);
});

test('multiple far-apart hits generate bounded, highlighted excerpts', () => {
  const text = 'target here. ' + 'Filler text. '.repeat(200) + 'Another target here. ' + 'Filler. '.repeat(200) + 'Final target.';
  const snippets = core.findSnippets(text, 'target', { maxSnippets: 2, maxLength: 160 });
  assert.equal(snippets.length, 2);
  assert.ok(snippets.every(snippet => snippet.segments.some(part => part.match)));
  assert.ok(snippets.every(snippet => snippet.text.length <= 168));
});

test('favorites recognize only the existing exact ★ tag', () => {
  assert.equal(core.isStarred([{ tag: '★' }]), true);
  assert.equal(core.isStarred(['⭐']), false);
  assert.equal(core.isStarred(['★️']), false);
  assert.equal(core.isStarred(['not ⭐ favorite']), false);
  assert.equal(core.isStarred([]), false);
});

test('note conversion yields inert plain text and decodes common entities', () => {
  assert.equal(core.displayText(core.noteText('<p>Charge &amp; voltage</p><script>bad()</script><p>&lt;img&gt; &#xC804;&#54616;</p>')), 'Charge & voltage <img> 전하');
});

test('a full phrase late in the document outranks the first three isolated occurrences', () => {
  const isolated = ('The triboelectric generator is tested. ' + 'Unrelated filler. '.repeat(100)).repeat(4);
  const text = isolated + 'Previous sentence. The triboelectric nanogenerator stores energy. Following sentence.';
  const snippets = core.findSnippets(text, 'Triboelectric Nanogenerator', { maxSnippets: 3 });
  assert.match(snippets[0].text, /Previous sentence\. The triboelectric nanogenerator stores energy\. Following sentence\./);
  assert.equal(snippets[0].relevance.exactPhrase, true);
  assert.equal(snippets[0].relevance.allTerms, true);
});

test('a nearby all-term window outranks isolated terms when there is no contiguous phrase', () => {
  const text = ('Stored data here. ' + 'Filler sentence. '.repeat(50)).repeat(3)
    + 'Before. Charge retained by the device is stored effectively. After.';
  const [snippet] = core.findSnippets(text, 'stored charge', { maxSnippets: 1 });
  assert.match(snippet.text, /Charge retained by the device is stored effectively/);
  assert.equal(snippet.relevance.exactPhrase, false); assert.equal(snippet.relevance.allTerms, true);
});

test('exact relevance requires complete Latin words and respects normalized whitespace and hyphens', () => {
  assert.equal(core.relevance('nanogenerator', 'generator').exactPhrase, false);
  assert.equal(core.relevance('Triboelectric nanogenerators', 'triboelectric nanogenerator').exactPhrase, false);
  assert.equal(core.relevance('Triboelectric–nanogenerator', 'triboelectric nanogenerator').exactPhrase, true);
  assert.equal(core.relevance('CAFÉ stored\ncharge', 'cafe stored charge').exactPhrase, true);
  assert.equal(core.relevance('전하량이 증가했다', '전하량').exactPhrase, true);
  assert.equal(core.relevance('C++ implementation', 'C++').exactPhrase, true);
});

test('many isolated terms still find a later complete-term window without quadratic rescanning', () => {
  const text = 'stored '.repeat(20000) + 'charge remains stored.';
  const [snippet] = core.findSnippets(text, 'stored charge', { maxSnippets: 1, maxLength: 160 });
  assert.equal(snippet.relevance.allTerms, true);
  assert.match(snippet.text, /charge/);
  assert.ok(snippet.text.length < 180);
});

test('malformed note markup is scanned forward and remains inert plain text', () => {
  for (const count of [2000, 8000, 64000]) {
    assert.equal(core.noteText('Before' + '<script>'.repeat(count) + 'unclosed executable-looking text'), 'Before ');
    assert.equal(core.noteText('Before' + '<style>'.repeat(count) + 'unclosed style'), 'Before ');
  }
  const unfinished = '<script '.repeat(8000);
  assert.equal(core.noteText(unfinished), unfinished, 'unfinished markup is harmless literal text, not HTML');
  assert.equal(core.displayText(core.noteText('<p>Before.</p><SCRIPT type="text/plain">ignored<script>ignored</SCRIPT><p>After &amp; safe.</p>')), 'Before. After & safe.');
});

test('phrase and context spanning chunk boundaries are preserved without duplicate snippets', () => {
  for (const offset of [32764, 32770, 65529]) {
    const prefix = ('x '.repeat(Math.ceil(offset / 2))).slice(0, offset - 1) + ' ';
    const snippets = core.findSnippets(prefix + 'Stored charge is retained. After sentence.', 'stored charge');
    assert.equal(snippets.length, 1);
    assert.equal(snippets[0].relevance.exactPhrase, true);
    assert.match(snippets[0].text, /Stored charge is retained\. After sentence\./);
  }
});

test('async complete-text scanning yields and cancels between chunks', async () => {
  let cancelled = false, yields = 0;
  const text = 'Unrelated sentence. '.repeat(160000) + 'Needle only at the end.';
  await assert.rejects(core.findSnippetsAsync(text, 'needle', {
    isCancelled: () => cancelled,
    yieldControl: async () => { if (++yields === 3) cancelled = true; },
  }), { name: 'AbortError' });
  assert.equal(yields, 3);
  const result = await core.findSnippetsAsync(text, 'needle', { yieldControl: async () => {} });
  assert.match(result[0].text, /Needle only at the end/);
});

test('large metadata relevance is cancellable and preserves exact phrases near its end', async () => {
  const text = 'Unrelated metadata. '.repeat(100000) + 'Stored charge';
  let cancelled = false;
  await assert.rejects(core.relevanceAsync(text, 'stored charge', {
    isCancelled: () => cancelled, yieldControl: async () => { cancelled = true; },
  }), { name: 'AbortError' });
  assert.equal((await core.relevanceAsync(text, 'stored charge')).exactPhrase, true);
});

test('six-megabyte late phrase stays within a bounded child-process heap budget', () => {
  const modulePath = JSON.stringify(require.resolve('../addon/content/snippets.js'));
  const script = `const core = require(${modulePath});
    const text = Array(3000).fill('Triboelectric results. ' + 'Unrelated sentence. '.repeat(100)).join('\\f')
      + 'Before. A triboelectric nanogenerator is tested. After.';
    const snippets = core.findSnippets(text, 'triboelectric nanogenerator', { indexedPages: 3000 });
    if (!snippets[0]?.relevance.exactPhrase || !snippets[0].text.includes('Before.')) process.exit(2);
    if (snippets[0].pageNumber !== 3000 || snippets[0].endPageNumber !== 3000) process.exit(3);
    console.log(JSON.stringify({ length: text.length, count: snippets.length }));`;
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', '-e', script], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4096,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.length > 6000000); assert.ok(output.count <= 3);
});

test('validated PDF page numbers follow the matching anchor, not neighboring excerpt sentences', () => {
  const text = 'First page introduction.\n\n\fSecond page unique target.\n\n\fThird page conclusion.';
  for (const [query, page] of [['introduction', 1], ['unique target', 2], ['conclusion', 3]]) {
    const [snippet] = core.findSnippets(text, query, { indexedPages: 3 });
    assert.equal(snippet.pageNumber, page);
    assert.equal(snippet.endPageNumber, page);
    const { pageNumber, endPageNumber, ...withoutPages } = snippet;
    assert.deepEqual(withoutPages, core.findSnippets(text, query)[0], 'display and relevance remain unchanged');
  }
  const [single] = core.findSnippets('One page target.', 'target', { indexedPages: 1 });
  assert.equal(single.pageNumber, 1); assert.equal(single.endPageNumber, 1);
});

test('cross-page phrases and dehyphenated words retain both physical page anchors', () => {
  for (const [text, query] of [
    ['First page stored\n\n\fcharge remains.', 'stored charge'],
    ['First page tribo-\n\f electric output.', 'triboelectric'],
    ['First page cafe\u0301\n\n\fenergy remains.', 'cafe energy'],
  ]) {
    const [snippet] = core.findSnippets(text, query, { indexedPages: 2 });
    assert.equal(snippet.pageNumber, 1);
    assert.equal(snippet.endPageNumber, 2);
    assert.equal(snippet.relevance.exactPhrase, true);
    assert.deepEqual(snippet.segments, core.findSnippets(text, query)[0].segments);
  }
});

test('page boundaries survive whitespace cleanup, Unicode folding, and interior blank pages', async () => {
  const text = '\ufeff😀 pre\u00adface.\n \f \nCAFE\u0301 tribo-\n electric fi\u200bnal.\n\f\n\fLast target.';
  for (const [query, page] of [['cafe triboelectric', 2], ['final', 2], ['last target', 4]]) {
    const [snippet] = await core.findSnippetsAsync(text, query, { indexedPages: 4 });
    assert.equal(snippet.pageNumber, page); assert.equal(snippet.endPageNumber, page);
    assert.equal(snippet.relevance.exactPhrase, true);
    assert.equal(snippet.segments.map(part => part.text).join(''), snippet.text);
  }
});

test('missing stats or lost edge-page separators never fabricate a physical page', () => {
  const invalid = [
    ['First\fTarget', undefined], ['First\fTarget', null], ['First\fTarget', '2'],
    ['First\fTarget', 1], ['First\fTarget', 3], ['Target', 0], ['Target', -1], ['Target', 1.5],
    ['\n\n\fTarget'.trim(), 2], ['Target\n\n\f\n\n'.trim(), 2],
  ];
  for (const [text, indexedPages] of invalid) {
    const [snippet] = core.findSnippets(text, 'target', { indexedPages });
    assert.ok(snippet);
    assert.equal(Object.hasOwn(snippet, 'pageNumber'), false);
    assert.equal(Object.hasOwn(snippet, 'endPageNumber'), false);
  }
});

test('identical passages on different pages use their own occurrence offsets', () => {
  const page = 'Previous sentence. Exact target passage. Following sentence. ' + 'Unrelated filler. '.repeat(80);
  const snippets = core.findSnippets([page, page, page].join('\f'), 'exact target', { indexedPages: 3, maxLength: 120 });
  assert.deepEqual(snippets.map(snippet => [snippet.pageNumber, snippet.endPageNumber]), [[1, 1], [2, 2], [3, 3]]);
  assert.ok(snippets.every(snippet => snippet.relevance.exactPhrase));
});
