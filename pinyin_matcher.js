'use strict';

/**
 * Pinyin-based classical Chinese recognition for CC Mobile.
 *
 * Ports app/translation/pinyin_matcher.py to JS.  Converts Whisper output and
 * reference classical verses to tone-stripped pinyin, then uses sliding-window
 * fuzzy matching (syllable-level Levenshtein) to replace garbled sequences
 * with the correct classical Chinese.
 *
 * Depends on pinyin-pro (loaded before this script as window.pinyinPro).
 *
 * Usage:
 *   await PinyinMatcher.init('/data/classical_refs/zhengdaoge.json');
 *   const corrected = PinyinMatcher.matchVerses('决学无为先导人');
 *   // → '絕學無為閒道人'
 */
(function () {

  // -- State -------------------------------------------------------------------

  /** @type {Map<number, Array<{zh: string, pinyin: string[], length: number}>>} */
  var versesByLength = new Map();
  var minLength = 0;
  var maxLength = 0;
  var totalVerses = 0;
  var ready = false;

  // -- Helpers -----------------------------------------------------------------

  /** CJK Unified Ideographs (basic + ext-A + ext-B) */
  var CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

  /**
   * Test whether a character is a CJK ideograph.
   * @param {string} ch  Single character
   * @returns {boolean}
   */
  function isCJK(ch) { return CJK_RE.test(ch); }

  /**
   * Convert Chinese text to tone-stripped pinyin syllables.
   * @param {string} text
   * @returns {string[]}
   */
  function toPinyin(text) {
    if (!text) return [];
    var result = pinyinPro.pinyin(text, { toneType: 'none', type: 'array' });
    // Defensive lowercase (pinyin-pro already returns lowercase, but be safe)
    for (var i = 0; i < result.length; i++) {
      result[i] = result[i].toLowerCase();
    }
    return result;
  }

  /**
   * Syllable-level Levenshtein distance between two pinyin arrays.
   * @param {string[]} a
   * @param {string[]} b
   * @returns {number}
   */
  function levenshtein(a, b) {
    var n = a.length, m = b.length;
    if (n === 0) return m;
    if (m === 0) return n;
    // Early bail: if lengths differ by more than max plausible edit distance
    if (Math.abs(n - m) > 3) return Math.abs(n - m);

    // Single-row DP
    var prev = new Array(m + 1);
    for (var j = 0; j <= m; j++) prev[j] = j;

    for (var i = 1; i <= n; i++) {
      var curr = new Array(m + 1);
      curr[0] = i;
      for (var j = 1; j <= m; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          curr[j - 1] + 1,   // insertion
          prev[j] + 1,       // deletion
          prev[j - 1] + cost  // substitution
        );
      }
      prev = curr;
    }
    return prev[m];
  }

  /**
   * Maximum allowed edit distance for a verse of given syllable length.
   * @param {number} syllableCount
   * @returns {number}
   */
  function maxEditDistance(syllableCount) {
    if (syllableCount <= 3) return 0;  // exact match only
    if (syllableCount <= 5) return 1;
    if (syllableCount <= 9) return 2;
    return 3;  // 10+ syllables
  }

  // -- Public API --------------------------------------------------------------

  /**
   * Load reference verses from a JSON URL and precompute pinyin.
   * Can be called multiple times to load additional verse files.
   * @param {string} jsonUrl  URL to a JSON array of {zh, en?, pl?} objects
   * @returns {Promise<void>}
   */
  async function init(jsonUrl) {
    if (typeof pinyinPro === 'undefined') {
      throw new Error('PinyinMatcher: pinyin-pro not loaded');
    }

    var res = await fetch(jsonUrl);
    if (!res.ok) throw new Error('PinyinMatcher: fetch failed ' + res.status);
    var data = await res.json();
    if (!Array.isArray(data)) throw new Error('PinyinMatcher: expected JSON array');

    var count = 0;
    for (var i = 0; i < data.length; i++) {
      var zh = (data[i].zh || '').trim();
      if (!zh || zh.length < 2) continue;

      var pinyin = toPinyin(zh);
      if (!pinyin.length) continue;

      var len = pinyin.length;
      var bucket = versesByLength.get(len);
      if (!bucket) {
        bucket = [];
        versesByLength.set(len, bucket);
      }
      bucket.push({ zh: zh, pinyin: pinyin, length: len });
      count++;
    }

    totalVerses += count;
    // Recompute bounds
    minLength = Infinity;
    maxLength = 0;
    versesByLength.forEach(function (_bucket, len) {
      if (len < minLength) minLength = len;
      if (len > maxLength) maxLength = len;
    });
    if (totalVerses === 0) { minLength = 0; maxLength = 0; }

    ready = true;
    console.log('PinyinMatcher: loaded ' + count + ' verses from ' + jsonUrl +
      ' (total: ' + totalVerses + ', range: ' + minLength + '–' + maxLength + ')');
  }

  /**
   * Find and replace garbled classical Chinese in Whisper output.
   * @param {string} text  Raw Chinese transcription
   * @returns {string}      Corrected text
   */
  function matchVerses(text) {
    if (!text || !totalVerses) return text;

    var chars = Array.from(text);  // handles surrogate pairs

    // Build punctuation-stripped text with index mapping.
    // Whisper inserts ，。、；％ and fullwidth Latin mid-verse — strip everything
    // that isn't CJK before matching, but keep a map back to original positions
    // so replacements cover the full span including embedded punctuation.
    var cleanChars = [];
    var cleanToOrig = [];  // cleanToOrig[i] = index in chars[] for clean char i
    for (var i = 0; i < chars.length; i++) {
      if (isCJK(chars[i])) {
        cleanChars.push(chars[i]);
        cleanToOrig.push(i);
      }
    }

    var cleanText = cleanChars.join('');
    var inputPinyin = toPinyin(cleanText);
    var n = inputPinyin.length;

    if (n < minLength) return text;

    // Collect match candidates: [cleanStart, cleanEnd, verseZh, editDist]
    var candidates = [];

    // Slide window from longest to shortest verse length
    for (var w = Math.min(maxLength, n); w >= minLength; w--) {
      var bucket = versesByLength.get(w);
      if (!bucket) continue;

      var maxDist = maxEditDistance(w);

      for (var start = 0; start <= n - w; start++) {
        var window = inputPinyin.slice(start, start + w);

        for (var v = 0; v < bucket.length; v++) {
          var verse = bucket[v];
          var dist = levenshtein(window, verse.pinyin);
          if (dist <= maxDist) {
            // Skip if clean text already matches exactly
            var cleanSpan = cleanChars.slice(start, start + w).join('');
            if (cleanSpan === verse.zh) continue;
            candidates.push([start, start + w, verse.zh, dist]);
          }
        }
      }
    }

    if (!candidates.length) return text;

    // Greedy non-overlapping: best edit distance first, longest as tiebreak
    candidates.sort(function (a, b) {
      if (a[3] !== b[3]) return a[3] - b[3];
      return (b[1] - b[0]) - (a[1] - a[0]);
    });

    var used = new Uint8Array(n);  // 0 = free
    var replacements = [];  // [origStart, origEnd, verseZh]

    for (var c = 0; c < candidates.length; c++) {
      var cand = candidates[c];
      var s = cand[0], e = cand[1];
      var overlap = false;
      for (var j = s; j < e; j++) {
        if (used[j]) { overlap = true; break; }
      }
      if (overlap) continue;

      // Map clean indices back to original text positions
      var origStart = cleanToOrig[s];
      // origEnd: one past the last original char covered by this span
      // (includes any punctuation between matched CJK chars)
      var origEnd = (e < cleanToOrig.length)
        ? cleanToOrig[e]    // start of next clean char
        : chars.length;     // matched to end of text

      replacements.push([origStart, origEnd, cand[2]]);
      for (var j = s; j < e; j++) used[j] = 1;
    }

    if (!replacements.length) return text;

    // Apply replacements right-to-left to preserve indices
    replacements.sort(function (a, b) { return b[0] - a[0]; });
    var result = chars.slice();
    for (var r = 0; r < replacements.length; r++) {
      var rep = replacements[r];
      var zhChars = Array.from(rep[2]);
      result.splice(rep[0], rep[1] - rep[0], ...zhChars);
    }

    return result.join('');
  }

  /**
   * @returns {boolean} True if at least one verse file has been loaded.
   */
  function isReady() { return ready; }

  /**
   * Count CJK Unified Ideograph characters in text.
   * @param {string} text
   * @returns {number}
   */
  function countCjk(text) {
    let n = 0;
    for (const ch of Array.from(text)) {
      if (isCJK(ch)) n++;
    }
    return n;
  }

  /**
   * Split corrected combined text back into prev and current portions.
   *
   * matchVerses() preserves CJK character count (each W-char verse replaces
   * exactly W CJK chars). This lets us split corrected prev+current text at
   * the original boundary by counting CJK chars.
   *
   * @param {string} corrected  Combined corrected text
   * @param {number} prevCjkCount  Number of CJK chars in the prev portion
   * @returns {[string, string]}  [prevPortion, currentPortion]
   */
  function splitCorrectedPair(corrected, prevCjkCount) {
    if (prevCjkCount <= 0) return ['', corrected];

    const chars = Array.from(corrected);
    let cjkSeen = 0;
    for (let i = 0; i < chars.length; i++) {
      if (isCJK(chars[i])) {
        cjkSeen++;
        if (cjkSeen === prevCjkCount) {
          const splitIdx = chars.slice(0, i + 1).join('').length;
          return [corrected.slice(0, splitIdx), corrected.slice(splitIdx)];
        }
      }
    }
    return [corrected, ''];
  }

  // -- Expose ------------------------------------------------------------------

  window.PinyinMatcher = {
    init: init,
    matchVerses: matchVerses,
    isReady: isReady,
    countCjk: countCjk,
    splitCorrectedPair: splitCorrectedPair,
  };

})();
