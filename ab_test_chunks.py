#!/usr/bin/env python3
"""AB test: chunk interval optimization for Whisper STT + verse matching.

Tests chunk intervals [3..90]s on a dharma talk audio clip to find the
knee of the curve where verse detection accuracy plateaus.

Usage:
    python ab_test_chunks.py --api-key sk-...
    python ab_test_chunks.py --dry-run
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from difflib import SequenceMatcher

import requests

# Add CC Scribe to path for PinyinMatcher import
_CC_SCRIBE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "CC Scribe")
if os.path.isdir(_CC_SCRIBE_DIR):
    sys.path.insert(0, _CC_SCRIBE_DIR)
from app.translation.pinyin_matcher import PinyinMatcher, split_corrected_pair as pm_split, _count_cjk as pm_count_cjk

try:
    import opencc
    _t2s = opencc.OpenCC("t2s")
    def to_simplified(text):
        return _t2s.convert(text)
except ImportError:
    def to_simplified(text):
        return text  # fallback: no conversion

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FFMPEG = os.path.join(
    os.path.expanduser("~"),
    r"AppData\Local\Microsoft\WinGet\Packages"
    r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    r"\ffmpeg-8.1-full_build\bin\ffmpeg.exe",
)
FFPROBE = FFMPEG.replace("ffmpeg.exe", "ffprobe.exe")
AUDIO_FILE = os.path.join(
    os.path.expanduser("~"),
    r"Downloads\Telegram Desktop\Zhengdao 90s.m4a",
)
WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions"
CACHE_FILE = os.path.join(SCRIPT_DIR, "ab_test_cache.json")
DEFAULT_INTERVALS = [3, 4, 5, 6, 7, 8, 10, 15, 30, 45, 90]

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


def load_verses():
    """Load reference verse zh strings from zhengdaoge.json."""
    path = os.path.join(SCRIPT_DIR, "zhengdaoge.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return [e["zh"] for e in data if "zh" in e]


def load_homophone_corrections():
    """Port of app.js buildZhCorrections() — build wrong->correct pairs."""
    path = os.path.join(SCRIPT_DIR, "glossary.json")
    with open(path, encoding="utf-8") as f:
        entries = json.load(f)

    alias_markers = ["Homophone alias", "Whisper mishears", "Whisper substitution"]
    zh_pattern = re.compile(
        r"(?:mishears|garbles)\s+(?:[\w\u00C0-\u024F]+\s+)*"
        r"([\u4e00-\u9fff][\u4e00-\u9fff\u7684]*)\s+"
        r"(?:\([^)]+\)\s+)?(?:as\b|transliteration)"
    )

    base_by_en = {}
    aliases = []

    for e in entries:
        notes = e.get("notes", "")
        is_alias = any(m in notes for m in alias_markers)
        if is_alias:
            aliases.append(e)
        else:
            base_by_en[e.get("en", "")] = e.get("zh", "")

    corrections = []
    for alias in aliases:
        notes = alias.get("notes", "")
        m = zh_pattern.search(notes)
        correct_zh = m.group(1).replace(" ", "") if m else base_by_en.get(alias.get("en", ""))
        if correct_zh and correct_zh != alias.get("zh", ""):
            corrections.append((alias["zh"], correct_zh))

    # Longest first for greedy matching
    corrections.sort(key=lambda x: len(x[0]), reverse=True)
    return corrections


# ---------------------------------------------------------------------------
# Text processing
# ---------------------------------------------------------------------------

CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")


def is_cjk(ch):
    return bool(CJK_RE.match(ch))


def count_cjk(text):
    return sum(1 for ch in text if is_cjk(ch))


def split_at_cjk_boundary(corrected, prev_cjk_count):
    """Port of splitCorrectedPair — split text at CJK char boundary."""
    if prev_cjk_count <= 0:
        return "", corrected
    cjk_seen = 0
    for i, ch in enumerate(corrected):
        if is_cjk(ch):
            cjk_seen += 1
            if cjk_seen == prev_cjk_count:
                return corrected[: i + 1], corrected[i + 1 :]
    return corrected, ""


def correct_chinese(text, corrections):
    """Port of app.js correctChinese — homophone replacement."""
    for wrong, correct in corrections:
        text = text.replace(wrong, correct)
    return text


def count_verse_matches(text, verses):
    """Count how many reference verses appear as substrings.

    Normalizes both sides to simplified Chinese since Whisper may output
    either simplified or traditional, and verses may be in traditional.
    """
    text_s = to_simplified(text)
    return sum(1 for v in verses if to_simplified(v) in text_s)


def char_accuracy(candidate, reference):
    """Character-level similarity between two Chinese texts (CJK only).

    Normalizes to simplified Chinese before comparison.
    """
    cand_s = to_simplified(candidate)
    ref_s = to_simplified(reference)
    cand_cjk = "".join(ch for ch in cand_s if is_cjk(ch))
    ref_cjk = "".join(ch for ch in ref_s if is_cjk(ch))
    if not ref_cjk:
        return 1.0 if not cand_cjk else 0.0
    return SequenceMatcher(None, cand_cjk, ref_cjk).ratio()


# ---------------------------------------------------------------------------
# Audio functions
# ---------------------------------------------------------------------------


def get_audio_duration(audio_path):
    """Get duration in seconds via ffprobe."""
    result = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", audio_path],
        capture_output=True, text=True, check=True,
    )
    return float(result.stdout.strip())


def convert_to_mp3(audio_path, temp_dir):
    """Convert input audio to mp3 (Whisper API rejects some m4a encodings)."""
    mp3_path = os.path.join(temp_dir, "input.mp3")
    subprocess.run(
        [FFMPEG, "-y", "-i", audio_path, "-f", "mp3", mp3_path],
        capture_output=True, check=True,
    )
    return mp3_path


def split_audio(audio_path, interval_sec, temp_dir):
    """Split audio into mp3 chunks using ffmpeg."""
    duration = get_audio_duration(audio_path)
    chunks = []
    start = 0.0
    idx = 0
    while start < duration:
        chunk_path = os.path.join(temp_dir, f"chunk_{interval_sec}s_{idx}.mp3")
        chunk_dur = min(interval_sec, duration - start)
        subprocess.run(
            [FFMPEG, "-y", "-i", audio_path,
             "-ss", str(start), "-t", str(chunk_dur),
             "-f", "mp3", chunk_path],
            capture_output=True, check=True,
        )
        chunks.append(chunk_path)
        start += interval_sec
        idx += 1
    return chunks


# ---------------------------------------------------------------------------
# Whisper API (urllib, no requests dependency)
# ---------------------------------------------------------------------------


def call_whisper(audio_path, api_key):
    """Call OpenAI Whisper API with multipart form upload."""
    ext = os.path.splitext(audio_path)[1].lstrip(".")
    mime = {"mp3": "audio/mpeg", "m4a": "audio/mp4", "wav": "audio/wav",
            "webm": "audio/webm", "ogg": "audio/ogg"}.get(ext, "audio/mpeg")
    with open(audio_path, "rb") as f:
        resp = requests.post(
            WHISPER_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (os.path.basename(audio_path), f, mime)},
            data={"model": "whisper-1", "language": "zh", "response_format": "text"},
            timeout=120,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Whisper API {resp.status_code}: {resp.text}")
    return resp.text.strip()


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


def load_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Pipeline processing
# ---------------------------------------------------------------------------


def process_with_window(transcriptions, corrections, matcher=None):
    """Sliding window: combine prev+current, pinyin match, then homophone correction."""
    prev_raw = ""
    results = []
    for raw in transcriptions:
        if prev_raw:
            combined = prev_raw + raw
            # Step 3: Pinyin fuzzy verse matching on combined window
            matched = matcher.match_verses(combined) if matcher else combined
            prev_cjk = pm_count_cjk(prev_raw)
            _, current = pm_split(matched, prev_cjk)
        else:
            # Step 3: Pinyin fuzzy verse matching
            current = matcher.match_verses(raw) if matcher else raw
        # Step 4: Glossary homophone correction
        current = correct_chinese(current, corrections)
        results.append(current)
        prev_raw = raw
    return "".join(results)


def process_without_window(transcriptions, corrections, matcher=None):
    """Independent per-chunk: pinyin match then homophone correction."""
    results = []
    for raw in transcriptions:
        matched = matcher.match_verses(raw) if matcher else raw
        results.append(correct_chinese(matched, corrections))
    return "".join(results)


# ---------------------------------------------------------------------------
# Plotting
# ---------------------------------------------------------------------------


def plot_results(results, gt_verses, gt_acc_ceiling):
    try:
        import matplotlib
        matplotlib.use("Agg")  # Non-interactive backend (no GUI window)
        import matplotlib.pyplot as plt
    except ImportError:
        print("\n[!] Install matplotlib for charts: python -m pip install matplotlib")
        return

    intervals = [r["interval"] for r in results]
    v_win = [r["verses_win"] for r in results]
    v_no = [r["verses_no"] for r in results]
    a_win = [r["acc_win"] for r in results]
    a_no = [r["acc_no"] for r in results]

    # Find knee: smallest interval at >= 95% of peak
    peak = max(v_win) if v_win else 0
    threshold = 0.95 * peak
    knee_idx = next((i for i, v in enumerate(v_win) if v >= threshold), 0)
    knee_interval = intervals[knee_idx]

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 8), sharex=True)
    fig.suptitle("Chunk Interval AB Test — Verse Detection vs Segment Size", fontsize=14)

    # Top: verse matches
    ax1.plot(intervals, v_win, "b-o", label="With sliding window", markersize=6)
    ax1.plot(intervals, v_no, "r--s", label="Without window", markersize=5)
    ax1.axhline(gt_verses, color="gray", linestyle=":", alpha=0.7,
                label=f"Ground truth ceiling ({gt_verses})")
    ax1.plot(knee_interval, v_win[knee_idx], "r*", markersize=18,
             label=f"Knee: {knee_interval}s ({v_win[knee_idx]} verses)")
    ax1.set_ylabel("Verse matches (substring)")
    ax1.legend(loc="lower right")
    ax1.grid(True, alpha=0.3)

    # Bottom: character accuracy
    ax2.plot(intervals, a_win, "b-o", label="With sliding window", markersize=6)
    ax2.plot(intervals, a_no, "r--s", label="Without window", markersize=5)
    ax2.set_xlabel("Chunk interval (seconds)")
    ax2.set_ylabel("Character accuracy vs ground truth")
    ax2.set_xticks(intervals)
    ax2.legend(loc="lower right")
    ax2.grid(True, alpha=0.3)

    plt.tight_layout()
    out_path = os.path.join(SCRIPT_DIR, "ab_test_results.png")
    plt.savefig(out_path, dpi=150)
    print(f"\nChart saved to {out_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    # UTF-8 stdout on Windows
    if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="AB test chunk intervals for Whisper STT")
    parser.add_argument("--api-key", help="OpenAI API key (or set OPENAI_API_KEY env)")
    parser.add_argument("--dry-run", action="store_true", help="Show plan without API calls")
    parser.add_argument("--intervals", help="Comma-separated intervals (default: 3,4,5,6,7,8,10,15,30,45,90)")
    parser.add_argument("--no-plot", action="store_true", help="Skip chart generation")
    parser.add_argument("--clear-cache", action="store_true", help="Clear Whisper cache")
    args = parser.parse_args()

    intervals = (
        [int(x) for x in args.intervals.split(",")]
        if args.intervals
        else DEFAULT_INTERVALS
    )

    # Resolve API key
    api_key = args.api_key or os.environ.get("OPENAI_API_KEY", "")
    if not api_key and not args.dry_run:
        api_key = input("Enter OpenAI API key: ").strip()
    if not api_key and not args.dry_run:
        print("Error: no API key provided", file=sys.stderr)
        sys.exit(1)

    # Verify prerequisites
    if not os.path.exists(FFMPEG):
        print(f"Error: ffmpeg not found at {FFMPEG}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(AUDIO_FILE):
        print(f"Error: audio file not found at {AUDIO_FILE}", file=sys.stderr)
        sys.exit(1)

    # Load data
    print("Loading data...")
    verses = load_verses()
    corrections = load_homophone_corrections()

    # Load pinyin fuzzy matcher (uses zhengdaoge.json via PinyinMatcher)
    verse_json = os.path.join(SCRIPT_DIR, "zhengdaoge.json")
    with open(verse_json, encoding="utf-8") as f:
        verse_data = json.load(f)
    from app.translation.pinyin_matcher import VerseEntry, _to_pinyin
    verse_entries = []
    for entry in verse_data:
        zh = entry.get("zh", "").strip()
        if not zh or len(zh) < 2:
            continue
        pinyin = tuple(_to_pinyin(zh))
        if pinyin:
            verse_entries.append(VerseEntry(zh=zh, pinyin=pinyin, length=len(pinyin)))
    matcher = PinyinMatcher(verse_entries)
    print(f"  PinyinMatcher: {len(verse_entries)} verses loaded")

    duration = get_audio_duration(AUDIO_FILE)
    print(f"  Audio: {os.path.basename(AUDIO_FILE)} ({duration:.1f}s)")
    print(f"  Verses: {len(verses)} loaded")
    print(f"  Corrections: {len(corrections)} homophone pairs")

    # Cache
    if args.clear_cache and os.path.exists(CACHE_FILE):
        os.remove(CACHE_FILE)
        print("  Cache cleared")
    cache = load_cache()
    print(f"  Cache: {len(cache)} entries")

    # Dry run
    if args.dry_run:
        print(f"\n=== DRY RUN ===")
        total_calls = 1  # ground truth
        for iv in intervals:
            n_chunks = math.ceil(duration / iv)
            cached = sum(1 for i in range(n_chunks) if f"{iv}_{i}" in cache)
            new = n_chunks - cached
            total_calls += new
            print(f"  {iv:3d}s -> {n_chunks:2d} chunks ({cached} cached, {new} new API calls)")
        gt_cached = "gt" in cache
        if gt_cached:
            total_calls -= 1
        print(f"  Ground truth: {'cached' if gt_cached else '1 API call'}")
        print(f"  Total new API calls: {total_calls}")
        print(f"  Est. cost: ~${total_calls * duration / len(intervals) / 60 * 0.006:.3f}")
        return

    # Use a single temp dir for all operations (mp3 conversion + chunking)
    with tempfile.TemporaryDirectory() as tmp:

    # --- Convert to mp3 (Whisper API rejects some m4a encodings) ---
        print("\nConverting to mp3...", end=" ", flush=True)
        mp3_file = convert_to_mp3(AUDIO_FILE, tmp)
        print("done")

    # --- Ground truth ---
        print("\n--- Ground truth (full audio) ---")
        if "gt" not in cache:
            print("  Calling Whisper...", end=" ", flush=True)
            t0 = time.time()
            cache["gt"] = call_whisper(mp3_file, api_key)
            save_cache(cache)
            print(f"done ({time.time() - t0:.1f}s)")
        else:
            print("  (cached)")
        gt_matched = matcher.match_verses(cache["gt"])
        gt_corrected = correct_chinese(gt_matched, corrections)
        gt_verses = count_verse_matches(gt_corrected, verses)
        print(f"  Raw: {cache['gt'][:80]}...")
        print(f"  Corrected: {gt_corrected[:80]}...")
        print(f"  Verse matches: {gt_verses}")

    # --- Per interval ---
        results = []
        for iv in intervals:
            print(f"\n--- {iv}s chunks ---")
            chunks = split_audio(mp3_file, iv, tmp)
            print(f"  {len(chunks)} chunks")

            transcriptions = []
            new_calls = 0
            for i, chunk_path in enumerate(chunks):
                key = f"{iv}_{i}"
                if key not in cache:
                    t0 = time.time()
                    cache[key] = call_whisper(chunk_path, api_key)
                    save_cache(cache)
                    new_calls += 1
                    elapsed = time.time() - t0
                    print(f"    chunk {i}: {elapsed:.1f}s — {cache[key][:40]}...")
                else:
                    print(f"    chunk {i}: (cached) — {cache[key][:40]}...")
                transcriptions.append(cache[key])

            text_win = process_with_window(transcriptions, corrections, matcher)
            text_no = process_without_window(transcriptions, corrections, matcher)

            v_win = count_verse_matches(text_win, verses)
            v_no = count_verse_matches(text_no, verses)
            a_win = char_accuracy(text_win, gt_corrected)
            a_no = char_accuracy(text_no, gt_corrected)

            results.append({
                "interval": iv,
                "chunks": len(chunks),
                "api_calls": new_calls,
                "verses_win": v_win,
                "verses_no": v_no,
                "acc_win": a_win,
                "acc_no": a_no,
            })
            print(f"  Verses: {v_win} (window) / {v_no} (no window)")
            print(f"  Accuracy: {a_win:.3f} (window) / {a_no:.3f} (no window)")

    # --- Summary table (outside temp dir context) ---
    print(f"\n{'='*72}")
    print(f"AB Test Results — Ground truth: {gt_verses} verse matches")
    print(f"{'='*72}")
    print(f"{'Interval':>8} | {'Chunks':>6} | {'V(win)':>6} | {'V(no)':>6} | {'Acc(win)':>8} | {'Acc(no)':>8}")
    print(f"{'-'*8}-+-{'-'*6}-+-{'-'*6}-+-{'-'*6}-+-{'-'*8}-+-{'-'*8}")
    for r in results:
        print(f"{r['interval']:>7}s | {r['chunks']:>6} | {r['verses_win']:>6} | "
              f"{r['verses_no']:>6} | {r['acc_win']:>8.3f} | {r['acc_no']:>8.3f}")

    # Knee detection
    peak = max(r["verses_win"] for r in results) if results else 0
    threshold = 0.95 * peak
    knee = next((r["interval"] for r in results if r["verses_win"] >= threshold), intervals[-1])
    print(f"\nKnee point: {knee}s (>= 95% of peak {peak} verses with window)")

    # Plot
    if not args.no_plot:
        plot_results(results, gt_verses, 1.0)


if __name__ == "__main__":
    main()
