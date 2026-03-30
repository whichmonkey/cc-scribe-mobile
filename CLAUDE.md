# CC Scribe Mobile

Real-time Buddhist dharma talk transcription and translation PWA.

## Architecture

Zero-build vanilla JS app. No bundler, no package.json. Dev server: `python -m http.server 8656`.

## Processing Pipeline (per 3s audio chunk)

Chunks are ordered by an async mutex (`pipelineGate`) through steps 1-3; translation (step 5) runs concurrently.

### 1. STT — OpenAI Whisper API (`whisper-1`)
- OpenAI hosted `whisper-1` via REST API (not stable-ts / faster-whisper)
- Routed through Cloudflare Worker CORS proxy (`worker/proxy.js` → `cc-scribe-proxy.workers.dev`)
- API key travels client → proxy → OpenAI

### 2. Hallucination filter
- `dedupStt()` checks against a 30+ entry blocklist (Cantonese YouTube artifacts, subscription CTAs, etc.)

### 3. Sliding window pinyin verse matching (`pinyin_matcher.js`)
- Concatenates previous chunk's raw STT + current chunk (`prevSttRaw + cleaned`) so verses spanning chunk boundaries are caught
- Strips embedded punctuation from CJK stream, keeps index map to original positions
- Converts to tone-stripped pinyin via `pinyin-pro`, slides windows longest-to-shortest verse length
- Syllable-level Levenshtein against reference verses (`zhengdaoge.json`)
- Thresholds: exact only for <=3 syllables, edit dist <=1 for 4-5, <=2 for 6-9, <=3 for 10+
- Greedy non-overlapping selection (best edit distance first, longest tiebreak)
- `splitCorrectedPair()` splits corrected combined text back at boundary by CJK char count

### 4. Glossary homophone correction (`glossary.json`)
Two entry types:
- **`type: "term"`** — base entries (e.g. 继程法师 = "Venerable Chi Chern"). Fed to Claude as terminology context.
- **`type: "homophone"`** — Whisper mishearing aliases (e.g. 继承法师, 既成法师 → 继程法师). Built into `zhCorrections` for string replacement.
- Homophones sorted longest-first for greedy matching. Correct form parsed from `notes` field or looked up by English name.

### 5. Claude translation
- Claude Haiku (`claude-haiku-4-5-20251001`) translates corrected Chinese → English + Polish
- System prompt includes base glossary terms only (aliases excluded)
- Skipped if neither EN nor PL display is enabled

### 6. Output
- Segment added to UI feed + persisted to localStorage
- Optionally published to Supabase for live audience sharing

## Deployment (manual, no CI/CD)

- **Frontend**: static files pushed to `master`, hosted at `/cc-scribe-mobile/`
- **CORS Proxy**: `npx wrangler deploy worker/proxy.js --name cc-scribe-proxy`
- **Backend**: Supabase (external, configured in app settings)

## Key Files

| File | Purpose |
|------|---------|
| `app.js` | Main app: recording, STT, translation, UI |
| `pinyin_matcher.js` | Syllable-level fuzzy verse matching (IIFE module) |
| `glossary.json` | Term definitions + homophone aliases |
| `zhengdaoge.json` | Reference classical Chinese verses |
| `sw.js` | Service worker (stale-while-revalidate) |
| `worker/proxy.js` | Cloudflare Worker CORS proxy for Whisper API |
| `lib/pinyin-pro.js` | Pre-bundled pinyin conversion library |

## Chunk Interval

`CHUNK_INTERVAL` in `app.js` controls the MediaRecorder cycle length. A/B tested intervals 3–90s
with the full pipeline (pinyin matcher + homophone correction). Results (`ab_test_chunks.py`):

| Interval | Verses detected (of 22) | CJK accuracy |
|----------|------------------------|-------------|
| 3s       | 11                     | 0.798       |
| 8s       | 18                     | 0.890       |
| 10s      | 21                     | 0.934       |
| 30s      | 23                     | 0.940       |

10s is the sweet spot: 95% of peak accuracy with reasonable display latency (11 chunks for ~100s audio).
Beyond 10s, sliding window adds no value (verses don't span boundaries). Currently set to 10s.

## Version

Update version number in `app.js` (`APP_VERSION`) before every push.
