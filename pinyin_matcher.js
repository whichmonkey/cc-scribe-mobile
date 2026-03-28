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
    if (Math.abs(n - m) > 2) return Math.abs(n - m);

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
    if (syllableCount <= 7) return 1;
    return 2;  // 8+ syllables
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
    var inputPinyin = toPinyin(text);
    var n = inputPinyin.length;

    if (n < minLength) return text;

    // Collect match candidates: [start, end, verseZh, editDist]
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
            // Skip if text already matches exactly
            var originalSpan = chars.slice(start, start + w).join('');
            if (originalSpan === verse.zh) continue;
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
    var replacements = [];

    for (var c = 0; c < candidates.length; c++) {
      var cand = candidates[c];
      var s = cand[0], e = cand[1];
      var overlap = false;
      for (var i = s; i < e; i++) {
        if (used[i]) { overlap = true; break; }
      }
      if (overlap) continue;
      replacements.push([s, e, cand[2]]);
      for (var i = s; i < e; i++) used[i] = 1;
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

  // -- Expose ------------------------------------------------------------------

  window.PinyinMatcher = { init: init, matchVerses: matchVerses, isReady: isReady };

})();
