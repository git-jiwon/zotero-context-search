/* Literal, display-only context extraction. No HTML is produced by this module. */
var ZCSCore = (() => {
  "use strict";

  function parseQuery(query) {
    const parts = [];
    const pattern = /"([^"]*)"|(\S+)/gu;
    for (const match of String(query || "").matchAll(pattern)) {
      const text = (match[1] === undefined ? match[2] : match[1]).trim();
      if (text) parts.push({ text, inQuotes: match[1] !== undefined });
    }
    return parts;
  }

  function displayText(value) {
    return String(value || "")
      .replace(/\u00ad/gu, "")
      .replace(/([\p{L}\p{N}])[-‐‑][ \t]*\r?\n\s*(?=[\p{L}\p{N}])/gu, "$1")
      .replace(/[\u200b\ufeff]/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function pageText(value, indexedPages) {
    let text = String(value || "");
    if (!Number.isSafeInteger(indexedPages) || indexedPages < 1) {
      return { text: displayText(text), pageStarts: null };
    }
    let pageStarts = [];
    for (let index = text.indexOf("\f"); index !== -1; index = text.indexOf("\f", index + 1)) {
      pageStarts.push(index + 1);
      if (pageStarts.length >= indexedPages) return { text: displayText(text), pageStarts: null };
    }
    // Native extraction trims the complete text. Blank leading/trailing pages
    // can therefore lose their form feeds; their page numbers cannot be guessed.
    if (pageStarts.length + 1 !== indexedPages) return { text: displayText(text), pageStarts: null };
    if (!pageStarts.length) return { text: displayText(text), pageStarts };

    // Carry only page boundaries through the existing display transformations.
    // This avoids allocating original offsets for every character in a PDF.
    const replace = (pattern, replacement) => {
      const mapped = [];
      let next = 0, delta = 0;
      text = text.replace(pattern, (...args) => {
        const match = args[0], offset = args[args.length - 2];
        const output = typeof replacement === "function" ? replacement(...args) : replacement;
        while (next < pageStarts.length && pageStarts[next] <= offset) mapped.push(pageStarts[next++] + delta);
        while (next < pageStarts.length && pageStarts[next] <= offset + match.length) {
          mapped.push(offset + delta + output.length); next++;
        }
        delta += output.length - match.length;
        return output;
      });
      while (next < pageStarts.length) mapped.push(pageStarts[next++] + delta);
      pageStarts = mapped;
    };
    replace(/\u00ad/gu, "");
    replace(/([\p{L}\p{N}])[-‐‑][ \t]*\r?\n\s*(?=[\p{L}\p{N}])/gu, (_, letter) => letter);
    replace(/[\u200b\ufeff]/gu, "");
    // Normalize whitespace in native string operations per page, rather than
    // invoking a JavaScript callback for every word boundary in a large PDF.
    const pieces = [], mapped = [];
    let cursor = 0, length = 0, trailingSpace = false;
    const append = end => {
      let part = text.slice(cursor, end).replace(/\s+/gu, " ");
      if (trailingSpace && part.startsWith(" ")) part = part.slice(1);
      if (part) {
        pieces.push(part); length += part.length; trailingSpace = part.endsWith(" ");
      }
      cursor = end;
    };
    for (const boundary of pageStarts) { append(boundary); mapped.push(length); }
    append(text.length);
    text = pieces.join(""); pageStarts = mapped;
    const leading = text.length - text.trimStart().length;
    text = text.trim();
    pageStarts = pageStarts.map(offset => Math.max(0, offset - leading));
    return { text, pageStarts };
  }

  function pageAt(pageStarts, offset) {
    let lower = 0, upper = pageStarts.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (pageStarts[middle] <= offset) lower = middle + 1;
      else upper = middle;
    }
    return lower + 1;
  }

  // Offsets always refer to the original displayed string, even after accent folding.
  function normalizedMap(value) {
    const characters = [];
    const starts = [], ends = [];
    let offset = 0, lastSeparator = false;
    for (const char of value) {
      const start = offset;
      offset += char.length;
      const folded = char.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
      for (const letter of folded) {
        if (/[\s\-‐‑‒–—−]/u.test(letter)) {
          if (lastSeparator) {
            ends[ends.length - 1] = offset;
            continue;
          }
          characters.push(" "); starts.push(start); ends.push(offset); lastSeparator = true;
        } else {
          characters.push(letter); lastSeparator = false;
          for (let i = 0; i < letter.length; i++) {
            starts.push(start); ends.push(offset);
          }
        }
      }
    }
    return { text: characters.join(""), starts, ends };
  }

  function queryInfo(query) {
    if (query && typeof query === "object" && Array.isArray(query.terms)) return query;
    const parts = parseQuery(query);
    const terms = [...new Set(parts.map(part => normalizedMap(displayText(part.text)).text.trim()).filter(Boolean))];
    const phrase = normalizedMap(displayText(parts.map(part => part.text).join(" "))).text.trim();
    return { terms, phrase, multiword: (phrase.match(/[\p{L}\p{N}]+/gu) || []).length > 1 };
  }

  // Native partial-word results remain visible, but do not earn an exact-match
  // promotion. Keep substring matching for CJK, where spaces do not delimit words.
  function wordEdge(character) { return !!character && /[\p{Script=Latin}\p{N}_]/u.test(character); }

  function* literalHits(map, needle, term = 0, wholeWords = true) {
    if (!needle) return;
    let from = 0, index;
    while ((index = map.text.indexOf(needle, from)) !== -1) {
      const end = index + needle.length;
      if (!wholeWords || (!(wordEdge(needle[0]) && wordEdge(map.text[index - 1]))
          && !(wordEdge(needle[needle.length - 1]) && wordEdge(map.text[end])))) {
        yield { start: map.starts[index], end: map.ends[end - 1], term };
      }
      from = index + Math.max(1, needle.length);
    }
  }

  const CHUNK_SIZE = 32768;

  function* textChunks(text, info, context = 0) {
    const overlap = Math.max(context + 32, info.phrase.length + 32, ...info.terms.map(term => term.length + 32));
    for (let lower = 0; lower < text.length; lower += CHUNK_SIZE) {
      const origin = Math.max(0, lower - overlap);
      const upper = Math.min(text.length, lower + CHUNK_SIZE);
      yield { lower, upper, origin, map: normalizedMap(text.slice(origin, Math.min(text.length, upper + overlap))) };
    }
  }

  function ownedHit(hit, chunk) {
    const start = chunk.origin + hit.start;
    return start >= chunk.lower && start < chunk.upper;
  }

  function consume(iterator) {
    let step;
    do { step = iterator.next(); } while (!step.done);
    return step.value;
  }

  async function consumeAsync(iterator, { yieldControl, isCancelled = () => false } = {}) {
    const check = () => {
      if (!isCancelled()) return;
      const error = new Error("Search cancelled"); error.name = "AbortError"; throw error;
    };
    try {
      while (true) {
        check();
        const step = iterator.next();
        if (step.done) { check(); return step.value; }
        if (yieldControl) await yieldControl();
        else await Promise.resolve();
      }
    }
    finally { iterator.return?.(); }
  }

  function* relevanceSteps(value, query) {
    const info = queryInfo(query);
    const text = displayText(value), found = new Set();
    if (!info.terms.length) return { exactPhrase: false, allTerms: false, matchedTerms: 0, totalTerms: 0 };
    for (const chunk of textChunks(text, info)) {
      for (const hit of literalHits(chunk.map, info.phrase)) {
        if (ownedHit(hit, chunk)) return { exactPhrase: true, allTerms: true, matchedTerms: info.terms.length, totalTerms: info.terms.length };
      }
      for (let index = 0; index < info.terms.length; index++) {
        if (found.has(index)) continue;
        for (const hit of literalHits(chunk.map, info.terms[index])) {
          if (ownedHit(hit, chunk)) { found.add(index); break; }
        }
      }
      if (chunk.upper < text.length) yield;
    }
    return {
      exactPhrase: false, allTerms: !!info.terms.length && found.size === info.terms.length,
      matchedTerms: found.size, totalTerms: info.terms.length,
    };
  }

  function relevance(value, query) { return consume(relevanceSteps(value, query)); }
  function relevanceAsync(value, query, options) { return consumeAsync(relevanceSteps(value, query), options); }

  function ranges(value, query) {
    const map = normalizedMap(value);
    const terms = Array.isArray(query) ? query : parseQuery(query);
    const matches = [];
    const seen = new Set();
    for (const part of terms) {
      const needle = normalizedMap(displayText(typeof part === "string" ? part : part.text)).text.trim();
      if (!needle || seen.has(needle)) continue;
      seen.add(needle);
      let from = 0, index;
      while ((index = map.text.indexOf(needle, from)) !== -1) {
        matches.push({ start: map.starts[index], end: map.ends[index + needle.length - 1] });
        from = index + Math.max(1, needle.length);
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const match of matches) {
      const last = merged[merged.length - 1];
      if (last && match.start <= last.end) last.end = Math.max(last.end, match.end);
      else merged.push({ ...match });
    }
    return merged;
  }

  function highlightSegments(text, query) {
    text = String(text || "");
    const segments = [];
    let offset = 0;
    for (const match of ranges(text, query)) {
      if (match.start > offset) segments.push({ text: text.slice(offset, match.start), match: false });
      segments.push({ text: text.slice(match.start, match.end), match: true });
      offset = match.end;
    }
    if (offset < text.length) segments.push({ text: text.slice(offset), match: false });
    return segments;
  }

  function sentenceRanges(text) {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      return Array.from(new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text),
        part => ({ start: part.index, end: part.index + part.segment.length }));
    }
    const result = [];
    const re = /[^.!?。！？]+(?:[.!?。！？]+(?:\s+|$)|$)|[.!?。！？]+/gu;
    for (const match of text.matchAll(re)) result.push({ start: match.index, end: match.index + match[0].length });
    return result.length ? result : [{ start: 0, end: text.length }];
  }

  function excerptFor(text, match, maxLength) {
    // Segment only the bounded neighborhood, never every sentence in a PDF.
    const origin = Math.max(0, match.start - maxLength);
    const nearby = text.slice(origin, Math.min(text.length, match.end + maxLength));
    const sentences = sentenceRanges(nearby);
    let sentenceIndex = 0;
    while (sentenceIndex + 1 < sentences.length && sentences[sentenceIndex].end <= match.start - origin) sentenceIndex++;
    let endSentence = sentenceIndex;
    while (endSentence + 1 < sentences.length && sentences[endSentence].end < match.end - origin) endSentence++;
    let start = origin + sentences[Math.max(0, sentenceIndex - 1)].start;
    let end = origin + sentences[Math.min(sentences.length - 1, endSentence + 1)].end;
    const budget = Math.max(maxLength, match.end - match.start + 40);
    if (end - start > budget) {
      start = Math.max(start, match.start - Math.floor((budget - (match.end - match.start)) / 2));
      end = Math.min(end, start + budget);
      start = Math.max(0, end - budget);
      const nextSpace = text.indexOf(" ", start);
      if (start > 0 && nextSpace >= start && nextSpace - start < 32 && nextSpace < match.start) start = nextSpace + 1;
      const prevSpace = text.lastIndexOf(" ", end);
      if (end < text.length && end - prevSpace < 32 && prevSpace >= match.end) end = prevSpace;
    }
    return { start, end, text: (start > 0 ? "… " : "") + text.slice(start, end).trim() + (end < text.length ? " …" : "") };
  }

  function* snippetSteps(value, query, options = {}) {
    const { text, pageStarts } = pageText(value, options.indexedPages), info = queryInfo(query);
    if (!text || !info.terms.length) return [];
    const limit = Math.min(3, Math.max(1, Math.floor(options.maxSnippets || 3)));
    const maxLength = Math.min(2048, Math.max(80, options.maxLength || 520));
    const selected = [];
    const compare = (a, b) => b.quality - a.quality
      || (a.quality === 2 ? (a.end - a.start) - (b.end - b.start) : 0)
      || a.start - b.start;
    const add = anchor => {
      if (selected.length === limit && compare(anchor, selected[selected.length - 1]) >= 0) return;
      if (selected.some(old => anchor.start < old.excerpt.end && anchor.end > old.excerpt.start && compare(anchor, old) >= 0)) return;
      const excerpt = excerptFor(text, anchor, maxLength);
      const overlaps = old => excerpt.start < old.excerpt.end && excerpt.end > old.excerpt.start;
      if (selected.some(old => overlaps(old) && compare(anchor, old) >= 0)) return;
      for (let index = selected.length - 1; index >= 0; index--) if (overlaps(selected[index])) selected.splice(index, 1);
      selected.push({ ...anchor, excerpt }); selected.sort(compare);
      if (selected.length > limit) selected.length = limit;
    };
    const full = () => selected.length === limit && selected.every(anchor => anchor.quality === 3);
    const output = () => selected.map(anchor => ({ text: anchor.excerpt.text,
      segments: highlightSegments(anchor.excerpt.text, query), relevance: relevance(anchor.excerpt.text, info),
      ...(pageStarts ? { pageNumber: pageAt(pageStarts, anchor.start),
        endPageNumber: pageAt(pageStarts, Math.max(anchor.start, anchor.end - 1)) } : {}),
    }));
    for (const chunk of textChunks(text, info, maxLength)) {
      for (const hit of literalHits(chunk.map, info.phrase)) {
        if (!ownedHit(hit, chunk)) continue;
        add({ start: chunk.origin + hit.start, end: chunk.origin + hit.end, quality: 3 });
        // Later hits cannot outrank these first complete phrases. This is a
        // proven top-result stop, never an arbitrary prefix or page limit.
        if (full()) return output();
      }
      // Merge lazy term iterators. Keep one latest hit per term instead of
      // allocating an array containing every occurrence in the document.
      const streams = info.terms.map((term, index) => literalHits(chunk.map, term, index));
      const next = streams.map(stream => stream.next());
      const latest = new Map();
      while (true) {
        let first = -1;
        for (let index = 0; index < next.length; index++) {
          if (!next[index].done && (first < 0 || next[index].value.start < next[first].value.start)) first = index;
        }
        if (first < 0) break;
        const hit = next[first].value;
        next[first] = streams[first].next();
        latest.set(hit.term, hit);
        if (latest.size === info.terms.length) {
          let start = Infinity, end = 0;
          for (const last of latest.values()) { start = Math.min(start, last.start); end = Math.max(end, last.end); }
          if (end - start <= maxLength - 40) add({ start: chunk.origin + start, end: chunk.origin + end, quality: 2 });
        }
        if (ownedHit(hit, chunk)) add({ start: chunk.origin + hit.start, end: chunk.origin + hit.end, quality: 1 });
      }
      if (selected.length < limit || selected[selected.length - 1].quality === 0) {
        for (const term of info.terms) {
          for (const hit of literalHits(chunk.map, term, 0, false)) {
            if (ownedHit(hit, chunk)) add({ start: chunk.origin + hit.start, end: chunk.origin + hit.end, quality: 0 });
          }
        }
      }
      if (chunk.upper < text.length) yield;
    }
    return output();
  }

  function findSnippets(value, query, options) { return consume(snippetSteps(value, query, options)); }
  function findSnippetsAsync(value, query, options = {}) { return consumeAsync(snippetSteps(value, query, options), options); }

  function* matchSteps(value, query) {
    const text = displayText(value), info = queryInfo(query);
    if (!info.terms.length) return false;
    for (const chunk of textChunks(text, info)) {
      for (const term of info.terms) {
        for (const hit of literalHits(chunk.map, term, 0, false)) if (ownedHit(hit, chunk)) return true;
      }
      if (chunk.upper < text.length) yield;
    }
    return false;
  }
  function matchesText(value, query) { return consume(matchSteps(value, query)); }
  function matchesTextAsync(value, query, options) { return consumeAsync(matchSteps(value, query), options); }
  function isStarred(tags) {
    return (tags || []).some(tag => String(typeof tag === "string" ? tag : tag.tag) === "★");
  }

  function noteText(html) {
    html = String(html || "");
    const output = [];
    let cursor = 0, ignored = null;
    while (cursor < html.length) {
      const open = html.indexOf("<", cursor);
      if (open < 0) { if (!ignored) output.push(html.slice(cursor)); break; }
      if (!ignored && open > cursor) output.push(html.slice(cursor, open));
      const close = html.indexOf(">", open + 1);
      if (close < 0) { if (!ignored) output.push(html.slice(open)); break; }
      const tag = /^\s*(\/?)\s*([a-z][a-z0-9]*)\b/i.exec(html.slice(open + 1, close));
      if (tag) {
        const name = tag[2].toLowerCase(), closing = !!tag[1];
        if (ignored) {
          if (closing && name === ignored) ignored = null;
        }
        else if (!closing && (name === "script" || name === "style")) { ignored = name; output.push(" "); }
        else if (/^(?:p|div|br|li|h[1-6])$/.test(name)) output.push("\n");
      }
      cursor = close + 1;
    }
    return output.join("")
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (whole, entity) => {
        if (entity[0] === "#") {
          const number = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
          return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : whole;
        }
        return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[entity.toLowerCase()] || whole;
      });
  }

  return { parseQuery, displayText, queryInfo, relevance, relevanceAsync, highlightSegments, findSnippets, findSnippetsAsync, matchesText, matchesTextAsync, isStarred, noteText };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZCSCore;
