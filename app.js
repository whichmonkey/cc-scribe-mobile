/**
 * CC Scribe Mobile — Standalone Web App
 *
 * Records audio from phone mic, sends to Whisper API for STT,
 * applies glossary correction, translates via Claude Haiku,
 * displays results. No server needed.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHUNK_INTERVAL  = 3000;   // 3-second MediaRecorder cycle
const WHISPER_MODEL   = 'whisper-1';
const CLAUDE_MODEL    = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION = '2023-06-01';

const HALLUCINATION_BLOCKLIST = [
  'subtitles', 'amara.org', 'subscribe', 'like and subscribe',
  'thank you for watching', 'thanks for watching', 'please subscribe',
  '字幕由', '字幕提供', '感谢观看', '请订阅', '謝謝觀看', '請訂閱',
  'ming pao', '明報', '明报',
  '多謝您收睇', '多谢您收睇', '時局新聞', '时局新闻', '收睇',
];

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const splash        = document.getElementById('splash');
const splashVideo   = document.getElementById('splash-video');
const recBtn        = document.getElementById('rec-btn');
const recLabel      = document.getElementById('rec-label');
const elapsedEl     = document.getElementById('elapsed');
const levelFill     = document.getElementById('level-fill');
const feed          = document.getElementById('feed');
const statusBadge   = document.getElementById('status-badge');
const shareBtn      = document.getElementById('share-btn');
const pauseBtn      = document.getElementById('pause-btn');
const saveBtn       = document.getElementById('save-btn');
const settingsBtn   = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const showZh        = document.getElementById('show-zh');
const showEn        = document.getElementById('show-en');
const showPl        = document.getElementById('show-pl');
const fontSlider    = document.getElementById('font-size');
const fontSizeVal   = document.getElementById('font-size-val');
const liveFontSlider = document.getElementById('live-font');
const liveFontVal   = document.getElementById('live-font-val');
const toastEl       = document.getElementById('toast');

// Live sharing language toggles
const liveZh = document.getElementById('live-zh');
const liveEn = document.getElementById('live-en');
const livePl = document.getElementById('live-pl');

// Advanced settings
const advancedToggle = document.getElementById('advanced-toggle');
const advancedBody   = document.getElementById('advanced-body');

// Settings inputs
const openaiKeyInput    = document.getElementById('openai-key');
const anthropicKeyInput = document.getElementById('anthropic-key');
const workerUrlInput    = document.getElementById('worker-url');
const supabaseUrlInput  = document.getElementById('supabase-url');
const supabaseKeyInput  = document.getElementById('supabase-key');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let recording     = false;
let paused        = false;
let mediaStream   = null;
let recorder      = null;
let mimeType      = '';
let elapsedSec    = 0;
let elapsedTimer  = null;
let levelCtx      = null;
let analyser      = null;
let isAtBottom    = true;
let wakeLock      = null;
let segId         = 0;
let processingCount = 0;
let segments      = [];    // All processed segments (for export)
let sessionId     = null;  // Random UUID per recording session

// Glossary state (loaded on init)
let glossaryEntries    = [];   // Full glossary array
let zhCorrections      = [];   // [{wrong, correct}] for homophone fixes
let systemPrompt       = '';   // Claude system prompt with glossary

// Supabase
let supabaseClient = null;

// ---------------------------------------------------------------------------
// Settings (localStorage)
// ---------------------------------------------------------------------------

function loadSettings() {
  openaiKeyInput.value    = localStorage.getItem('ccscribe_openai_key') || '';
  anthropicKeyInput.value = localStorage.getItem('ccscribe_anthropic_key') || '';
  workerUrlInput.value    = localStorage.getItem('ccscribe_worker_url') || '';
  supabaseUrlInput.value  = localStorage.getItem('ccscribe_supabase_url') || '';
  supabaseKeyInput.value  = localStorage.getItem('ccscribe_supabase_key') || '';

  showZh.checked = localStorage.getItem('ccscribe_show_zh') !== 'false';
  showEn.checked = localStorage.getItem('ccscribe_show_en') !== 'false';
  showPl.checked = localStorage.getItem('ccscribe_show_pl') !== 'false';

  liveZh.checked = localStorage.getItem('ccscribe_live_zh') !== 'false';
  liveEn.checked = localStorage.getItem('ccscribe_live_en') !== 'false';
  livePl.checked = localStorage.getItem('ccscribe_live_pl') !== 'false';

  fontSlider.value = localStorage.getItem('ccscribe_font_size') || '100';
  liveFontSlider.value = localStorage.getItem('ccscribe_live_font') || '150';

  updateFontSize();
  updateLiveFont();
  updateVisibility();
}

function saveSettings() {
  localStorage.setItem('ccscribe_openai_key', openaiKeyInput.value);
  localStorage.setItem('ccscribe_anthropic_key', anthropicKeyInput.value);
  localStorage.setItem('ccscribe_worker_url', workerUrlInput.value);
  localStorage.setItem('ccscribe_supabase_url', supabaseUrlInput.value);
  localStorage.setItem('ccscribe_supabase_key', supabaseKeyInput.value);
  localStorage.setItem('ccscribe_show_zh', showZh.checked);
  localStorage.setItem('ccscribe_show_en', showEn.checked);
  localStorage.setItem('ccscribe_show_pl', showPl.checked);
  localStorage.setItem('ccscribe_live_zh', liveZh.checked);
  localStorage.setItem('ccscribe_live_en', liveEn.checked);
  localStorage.setItem('ccscribe_live_pl', livePl.checked);
  localStorage.setItem('ccscribe_font_size', fontSlider.value);
  localStorage.setItem('ccscribe_live_font', liveFontSlider.value);
}

function getOpenaiKey()    { return openaiKeyInput.value.trim(); }
function getAnthropicKey() { return anthropicKeyInput.value.trim(); }
function getWorkerUrl()    { return workerUrlInput.value.trim().replace(/\/$/, ''); }

// ---------------------------------------------------------------------------
// Glossary loading and homophone correction
// ---------------------------------------------------------------------------

async function loadGlossary() {
  try {
    const res = await fetch('glossary.json');
    glossaryEntries = await res.json();

    // Sort by Chinese term length, longest first (greedy matching)
    glossaryEntries.sort((a, b) => b.zh.length - a.zh.length);

    // Build homophone corrections from alias entries
    buildZhCorrections();

    // Build Claude system prompt (base entries only, exclude aliases)
    buildSystemPrompt();

    console.log(`Glossary loaded: ${glossaryEntries.length} entries, ${zhCorrections.length} corrections`);
  } catch (e) {
    console.error('Failed to load glossary:', e);
  }
}

function buildZhCorrections() {
  const aliasMarkers = ['Homophone alias', 'Whisper mishears', 'Whisper substitution'];
  const zhPattern = /(?:mishears|garbles)\s+(?:[\w\u00C0-\u024F]+\s+)*([\u4e00-\u9fff][\u4e00-\u9fff\u7684]*)\s+(?:\([^)]+\)\s+)?(?:as\b|transliteration)/;

  // Build base entry lookup by EN
  const baseByEn = {};
  const aliases = [];

  for (const e of glossaryEntries) {
    const isAlias = aliasMarkers.some(m => e.notes.includes(m));
    if (isAlias) {
      aliases.push(e);
    } else {
      baseByEn[e.en] = e.zh;
    }
  }

  zhCorrections = [];
  for (const alias of aliases) {
    // Try parsing correct ZH from notes
    const m = zhPattern.exec(alias.notes);
    let correctZh = m ? m[1].replace(/ /g, '') : baseByEn[alias.en];

    if (correctZh && correctZh !== alias.zh) {
      zhCorrections.push({ wrong: alias.zh, correct: correctZh });
    }
  }

  // Sort by wrong length, longest first
  zhCorrections.sort((a, b) => b.wrong.length - a.wrong.length);
}

function correctChinese(text) {
  for (const { wrong, correct } of zhCorrections) {
    if (text.includes(wrong)) {
      text = text.split(wrong).join(correct);
    }
  }
  return text;
}

function buildSystemPrompt() {
  const aliasMarkers = ['Homophone alias', 'Whisper mishears', 'Whisper substitution'];
  const baseEntries = glossaryEntries.filter(
    e => !aliasMarkers.some(m => e.notes.includes(m))
  );

  const lines = [
    'You are a translator for Chinese Buddhist dharma talks (Chan/Zen tradition).',
    'Translate the Chinese text into both English and Polish.',
    'Output EXACTLY two lines, no other text:',
    'EN: <english translation>',
    'PL: <polish translation>',
    '',
    'Guidelines:',
    '- Faithful, natural translation \u2014 not word-for-word',
    '- Preserve the speaker\'s tone (teaching, conversational)',
    '- Use the glossary terms below when applicable',
    '- For terms not in glossary, use standard Buddhist English translations',
    '- Do NOT add commentary, notes, explanations, or ask for clarification',
    '- If the input is a short fragment or incomplete sentence, translate it as-is',
    '- NEVER refuse to translate or say the text is incomplete \u2014 just translate what is given',
    '- Keep translation proportional to the input length \u2014 do NOT elaborate or expand',
  ];

  if (baseEntries.length > 0) {
    lines.push('');
    lines.push(`Glossary (${baseEntries.length} terms, Chinese \u2192 English / Polish):`);
    for (const e of baseEntries) {
      lines.push(`  ${e.zh} \u2192 ${e.en} / ${e.pl}`);
    }
  }

  lines.push('');
  lines.push('CRITICAL RULES (must follow):');
  lines.push('- Output format is EXACTLY: EN: <text>\\nPL: <text>');
  lines.push('- NEVER add commentary, explanations, or refuse to translate');
  lines.push('- Short fragments (even 1-2 characters) must be translated literally');
  lines.push('- Translation length must be proportional to input \u2014 do NOT expand or elaborate');

  systemPrompt = lines.join('\n');
}

// ---------------------------------------------------------------------------
// Hallucination filter
// ---------------------------------------------------------------------------

function dedupStt(text) {
  if (!text || text.length < 6) return text;

  const lower = text.toLowerCase().trim();
  for (const phrase of HALLUCINATION_BLOCKLIST) {
    if (lower.includes(phrase)) return '';
  }

  return text.trim();
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function callWhisper(blob) {
  const workerUrl = getWorkerUrl();
  const openaiKey = getOpenaiKey();

  if (!workerUrl || !openaiKey) {
    throw new Error('Set OpenAI key and Worker URL in settings');
  }

  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const formData = new FormData();
  formData.append('file', blob, `audio.${ext}`);
  formData.append('model', WHISPER_MODEL);
  formData.append('language', 'zh');
  formData.append('response_format', 'text');

  const res = await fetch(`${workerUrl}/openai/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Whisper ${res.status}: ${err}`);
  }

  // response_format=text returns plain text
  return (await res.text()).trim();
}

async function callClaude(chineseText) {
  const anthropicKey = getAnthropicKey();
  if (!anthropicKey) throw new Error('Set Anthropic key in settings');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: [{
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: chineseText }],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Claude ${res.status}: ${err}`);
  }

  const data = await res.json();
  return parseClaudeResponse(data.content[0].text);
}

function parseClaudeResponse(text) {
  let english = '';
  let polish = '';

  for (const line of text.trim().split('\n')) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith('EN:')) {
      english = trimmed.slice(3).trim();
    } else if (trimmed.toUpperCase().startsWith('PL:')) {
      polish = trimmed.slice(3).trim();
    }
  }

  // Fallback: treat entire response as English — but detect Claude refusals
  if (!english && !polish) {
    const lower = text.toLowerCase();
    if (lower.includes('i cannot translate') || lower.includes('i need to clarify')
        || lower.includes('not a buddhist') || lower.includes('outside my specified')
        || lower.includes('i appreciate the reminder') || text.length > 300) {
      // Claude refused or produced a long non-translation — skip
      return { english: '', polish: '' };
    }
    english = text.trim();
  }

  return { english, polish };
}

// ---------------------------------------------------------------------------
// Processing pipeline
// ---------------------------------------------------------------------------

async function processChunk(blob) {
  processingCount++;
  updateStatusBadge();

  try {
    // 1. Whisper STT
    const rawChinese = await callWhisper(blob);
    if (!rawChinese) return;

    // 2. Hallucination check
    const cleaned = dedupStt(rawChinese);
    if (!cleaned) return;

    // 3. Glossary homophone correction
    const chinese = correctChinese(cleaned);

    // 4. Claude translation
    const { english, polish } = await callClaude(chinese);
    if (!english && !polish) return; // Claude refusal or hallucination — skip

    // 5. Build segment
    const segment = {
      id: ++segId,
      chinese,
      english,
      polish,
      start_time: elapsedSec,
    };
    segments.push(segment);

    // 6. Display
    addSegment(segment);

    // 7. Publish to Supabase (if configured)
    publishToSupabase(segment);

  } catch (err) {
    console.error('Processing error:', err);
    showToast(err.message, true);
  } finally {
    processingCount--;
    updateStatusBadge();
  }
}

// ---------------------------------------------------------------------------
// Audio recording
// ---------------------------------------------------------------------------

function createRecorder() {
  mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/mp4')
      ? 'audio/mp4'
      : 'audio/webm';

  const rec = new MediaRecorder(mediaStream, { mimeType });

  rec.ondataavailable = (ev) => {
    if (ev.data.size > 0 && recording && !paused) {
      // Fire-and-forget: process concurrently
      processChunk(ev.data);
    }
  };

  rec.onstop = () => {
    if (recording && !paused) {
      recorder = createRecorder();
      recorder.start();
      setTimeout(() => {
        if (recording && !paused && recorder.state === 'recording') {
          recorder.stop();
        }
      }, CHUNK_INTERVAL);
    }
  };

  return rec;
}

function startRecorderCycle() {
  recorder = createRecorder();
  recorder.start();
  setTimeout(() => {
    if (recording && !paused && recorder.state === 'recording') {
      recorder.stop();
    }
  }, CHUNK_INTERVAL);
}

async function startRecording() {
  // Validate API keys
  if (!getOpenaiKey() || !getAnthropicKey() || !getWorkerUrl()) {
    showToast('Enter API keys and Worker URL in settings', true);
    openSettings();
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert('Microphone access denied. Please allow mic access and try again.');
    return;
  }

  // Generate session ID (reuse if already created via Share)
  if (!sessionId) sessionId = crypto.randomUUID();

  // Start recording cycle
  startRecorderCycle();
  recording = true;
  paused = false;

  // UI
  recBtn.classList.add('recording');
  recLabel.textContent = 'STOP';
  pauseBtn.classList.remove('hidden');
  pauseBtn.disabled = false;
  saveBtn.disabled = true;
  shareBtn.disabled = false;

  // Elapsed timer
  elapsedSec = 0;
  elapsedEl.textContent = '00:00';
  elapsedTimer = setInterval(() => {
    if (!paused) {
      elapsedSec++;
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      elapsedEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
  }, 1000);

  // Wake lock
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').then(l => { wakeLock = l; }).catch(() => {});
  }

  // Level meter
  setupLevelMeter(mediaStream);
}

async function stopRecording() {
  recording = false;
  paused = false;

  if (recorder && recorder.state !== 'inactive') recorder.stop();
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  if (levelCtx) {
    levelCtx.close();
    levelCtx = null;
    analyser = null;
  }
  clearInterval(elapsedTimer);
  if (wakeLock) { wakeLock.release(); wakeLock = null; }

  // Upload transcript to Supabase
  uploadTranscript();

  // UI
  recBtn.classList.remove('recording');
  recLabel.textContent = 'START';
  pauseBtn.classList.add('hidden');
  pauseBtn.textContent = 'Pause';
  saveBtn.disabled = segments.length === 0;
  levelFill.style.width = '0%';
}

function togglePause() {
  if (!recording) return;

  if (paused) {
    paused = false;
    pauseBtn.textContent = 'Pause';
    recBtn.classList.add('recording');
    startRecorderCycle();
  } else {
    paused = true;
    pauseBtn.textContent = 'Resume';
    recBtn.classList.remove('recording');
    if (recorder && recorder.state === 'recording') recorder.stop();
  }
}

// ---------------------------------------------------------------------------
// Level meter
// ---------------------------------------------------------------------------

function setupLevelMeter(stream) {
  levelCtx = new AudioContext();
  analyser = levelCtx.createAnalyser();
  analyser.fftSize = 256;
  const src = levelCtx.createMediaStreamSource(stream);
  src.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);

  function tick() {
    if (!analyser) return;
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const pct = Math.min(100, (avg / 128) * 100);
    levelFill.style.width = pct + '%';
    requestAnimationFrame(tick);
  }
  tick();
}

// ---------------------------------------------------------------------------
// Feed display
// ---------------------------------------------------------------------------

function addSegment(msg) {
  let existing = document.getElementById(`seg-${msg.id}`);
  if (existing) {
    const zh = existing.querySelector('.seg-zh');
    const en = existing.querySelector('.seg-en');
    const pl = existing.querySelector('.seg-pl');
    if (zh) zh.textContent = msg.chinese || '';
    if (en) en.textContent = msg.english || '';
    if (pl) pl.textContent = msg.polish || '';
    return;
  }

  const div = document.createElement('div');
  div.className = 'segment';
  div.id = `seg-${msg.id}`;

  const startSec = msg.start_time || 0;
  const m = Math.floor(startSec / 60);
  const s = Math.floor(startSec % 60);

  div.innerHTML = `
    <div class="seg-ts">${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}</div>
    <div class="seg-zh">${esc(msg.chinese || '')}</div>
    <div class="seg-en">${esc(msg.english || '')}</div>
    <div class="seg-pl">${esc(msg.polish || '')}</div>
  `;

  feed.appendChild(div);

  if (isAtBottom) {
    div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Smart auto-scroll
feed.addEventListener('scroll', () => {
  const threshold = 50;
  isAtBottom = (feed.scrollTop + feed.clientHeight >= feed.scrollHeight - threshold);
});

// ---------------------------------------------------------------------------
// Supabase (audience sharing + transcript logging)
// ---------------------------------------------------------------------------

function initSupabase() {
  const url = supabaseUrlInput.value.trim();
  const key = supabaseKeyInput.value.trim();
  if (!url || !key || typeof supabase === 'undefined') {
    supabaseClient = null;
    return;
  }
  supabaseClient = supabase.createClient(url, key);
}

async function publishToSupabase(segment) {
  if (!supabaseClient || !sessionId) return;
  try {
    await supabaseClient.from('segments').insert({
      session_id: sessionId,
      segment_number: segment.id,
      chinese: segment.chinese,
      english: segment.english,
      polish: segment.polish,
    });
  } catch (e) {
    console.warn('Supabase publish failed:', e);
  }
}

async function uploadTranscript() {
  if (!supabaseClient || segments.length === 0) return;
  try {
    await supabaseClient.from('transcripts').insert({
      session_id: sessionId,
      segments: JSON.stringify(segments),
      duration: elapsedSec,
    });
  } catch (e) {
    console.warn('Transcript upload failed:', e);
  }
}

// Audience mode: subscribe to a session's segments
function enterAudienceMode(targetSessionId) {
  document.body.classList.add('audience-mode');

  // Apply URL parameters for display
  const params = new URLSearchParams(location.search);
  const font = params.get('font');
  if (font) document.documentElement.style.setProperty('--scale', parseInt(font) / 100);
  if (params.get('zh') === '0') feed.classList.add('hide-zh');
  if (params.get('en') === '0') feed.classList.add('hide-en');
  if (params.get('pl') === '0') feed.classList.add('hide-pl');

  // Subscribe to Supabase realtime
  if (!supabaseClient) {
    initSupabase();
    if (!supabaseClient) {
      feed.innerHTML = '<div style="color:var(--muted);text-align:center;margin-top:3rem">Configure Supabase in settings to receive live segments</div>';
      return;
    }
  }

  supabaseClient
    .channel(`session-${targetSessionId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'segments', filter: `session_id=eq.${targetSessionId}` },
      (payload) => {
        const row = payload.new;
        addSegment({
          id: row.segment_number,
          chinese: row.chinese,
          english: row.english,
          polish: row.polish,
        });
      }
    )
    .subscribe();
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

function shareSession() {
  // Generate session ID on first share (before recording starts)
  if (!sessionId) {
    sessionId = crypto.randomUUID();
  }

  const params = new URLSearchParams({
    session: sessionId,
    font: liveFontSlider.value,
    zh: liveZh.checked ? '1' : '0',
    en: liveEn.checked ? '1' : '0',
    pl: livePl.checked ? '1' : '0',
  });

  const url = `${location.origin}${location.pathname}?${params}`;

  // Copy to clipboard
  let copied = false;
  try {
    navigator.clipboard.writeText(url);
    copied = true;
  } catch { /* blocked */ }

  if (!copied) {
    const tmp = document.createElement('input');
    tmp.value = url;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
  }

  shareBtn.textContent = 'Link copied!';
  setTimeout(() => { shareBtn.textContent = 'Copy Live Link'; }, 2000);
}

// ---------------------------------------------------------------------------
// Save / Export
// ---------------------------------------------------------------------------

function saveTranscript() {
  if (segments.length === 0) {
    showToast('No transcript to save');
    return;
  }

  const lines = [];
  for (const seg of segments) {
    const m = Math.floor((seg.start_time || 0) / 60);
    const s = Math.floor((seg.start_time || 0) % 60);
    const ts = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    lines.push(`[${ts}]`);
    if (seg.chinese) lines.push(`ZH: ${seg.chinese}`);
    if (seg.english) lines.push(`EN: ${seg.english}`);
    if (seg.polish)  lines.push(`PL: ${seg.polish}`);
    lines.push('');
  }

  const text = lines.join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cc_scribe_${new Date().toISOString().slice(0, 16).replace(/[:-]/g, '')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function updateStatusBadge() {
  if (processingCount > 0) {
    statusBadge.textContent = `Processing (${processingCount})`;
    statusBadge.className = 'status-badge processing';
  } else if (recording) {
    statusBadge.textContent = 'Recording';
    statusBadge.className = 'status-badge processing';
  } else {
    statusBadge.textContent = 'Ready';
    statusBadge.className = 'status-badge idle';
  }
}

function updateVisibility() {
  feed.classList.toggle('hide-zh', !showZh.checked);
  feed.classList.toggle('hide-en', !showEn.checked);
  feed.classList.toggle('hide-pl', !showPl.checked);
}

function updateFontSize() {
  fontSizeVal.textContent = fontSlider.value + '%';
  document.documentElement.style.setProperty('--scale', fontSlider.value / 100);
}

function updateLiveFont() {
  liveFontVal.textContent = liveFontSlider.value + '%';
}

function openSettings() {
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
  saveSettings();
  initSupabase();
}

let toastTimer = null;
function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast hidden'; }, 3000);
}

// ---------------------------------------------------------------------------
// Splash screen
// ---------------------------------------------------------------------------

function dismissSplash() {
  if (!splash) return;
  splash.classList.add('fade-out');
  setTimeout(() => splash.remove(), 800);
}

if (splashVideo) {
  splashVideo.addEventListener('ended', dismissSplash);
  setTimeout(dismissSplash, 7000);
}
if (splash) {
  splash.addEventListener('click', dismissSplash);
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

recBtn.addEventListener('click', () => {
  if (recording) stopRecording(); else startRecording();
});

pauseBtn.addEventListener('click', togglePause);
shareBtn.addEventListener('click', shareSession);
saveBtn.addEventListener('click', saveTranscript);
settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

showZh.addEventListener('change', () => { updateVisibility(); saveSettings(); });
showEn.addEventListener('change', () => { updateVisibility(); saveSettings(); });
showPl.addEventListener('change', () => { updateVisibility(); saveSettings(); });
liveZh.addEventListener('change', saveSettings);
liveEn.addEventListener('change', saveSettings);
livePl.addEventListener('change', saveSettings);
fontSlider.addEventListener('input', () => { updateFontSize(); saveSettings(); });
liveFontSlider.addEventListener('input', () => { updateLiveFont(); saveSettings(); });

// Advanced toggle (collapsible)
advancedToggle.addEventListener('click', () => {
  advancedBody.classList.toggle('hidden');
  advancedToggle.querySelector('.toggle-arrow').classList.toggle('open');
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  loadSettings();
  await loadGlossary();
  initSupabase();

  // Check for audience mode
  const params = new URLSearchParams(location.search);
  const audienceSession = params.get('session');
  if (audienceSession) {
    enterAudienceMode(audienceSession);
    return;
  }

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
