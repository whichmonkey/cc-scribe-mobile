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
  '多謝您', '多谢您', '再會', '再会',
  '點贊', '点赞', '訂閱', '订阅', '打賞', '打赏',
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
const clearBtn      = document.getElementById('clear-btn');
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
let correctionHits     = new Map(); // { wrong → count } per session
let systemPrompt       = '';   // Claude system prompt with glossary

// Supabase defaults (anon key is safe to expose — it's a public, read/insert-only key)
const SUPABASE_DEFAULT_URL = 'https://zkfhuuprrzjlbnixumog.supabase.co';
const SUPABASE_DEFAULT_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InprZmh1dXBycnpqbGJuaXh1bW9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3ODIwODksImV4cCI6MjA4OTM1ODA4OX0.JhI_thkVQqc1HbbN9xagdAGn848Re3RL6h-ZpmvNIWA';
let supabaseClient = null;

// ---------------------------------------------------------------------------
// Session persistence (localStorage)
// ---------------------------------------------------------------------------

function persistSession() {
  localStorage.setItem('ccscribe_segments', JSON.stringify(segments));
  localStorage.setItem('ccscribe_segId', String(segId));
  localStorage.setItem('ccscribe_sessionId', sessionId || '');
  localStorage.setItem('ccscribe_elapsedSec', String(elapsedSec));
}

function restoreSession() {
  const saved = localStorage.getItem('ccscribe_segments');
  if (!saved) return;

  try {
    const restored = JSON.parse(saved);
    if (!Array.isArray(restored) || restored.length === 0) return;

    segments = restored;
    segId = parseInt(localStorage.getItem('ccscribe_segId') || '0', 10);
    sessionId = localStorage.getItem('ccscribe_sessionId') || null;
    elapsedSec = parseInt(localStorage.getItem('ccscribe_elapsedSec') || '0', 10);

    // Rebuild feed
    for (const seg of segments) {
      addSegment(seg);
    }

    // Restore elapsed display
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    elapsedEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    // Enable buttons
    clearBtn.disabled = false;
    saveBtn.disabled = false;
  } catch (e) {
    console.error('Failed to restore session:', e);
  }
}

// ---------------------------------------------------------------------------
// Crypto utilities (Web Crypto API — AES-GCM + PBKDF2)
// ---------------------------------------------------------------------------

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function toBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function encryptConfig(configObj, pin) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));

  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  const aesKey  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt']
  );

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(configObj)));
  return `${bytesToHex(salt)}.${bytesToHex(iv)}.${toBase64Url(ciphertext)}`;
}

async function decryptConfig(payload, pin) {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Invalid config payload');

  const salt       = hexToBytes(parts[0]);
  const iv         = hexToBytes(parts[1]);
  const ciphertext = fromBase64Url(parts[2]);

  const enc     = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  const aesKey  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, ['decrypt']
  );

  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// ---------------------------------------------------------------------------
// PIN dialog
// ---------------------------------------------------------------------------

const pinOverlay = document.getElementById('pin-overlay');
const pinDialog  = document.getElementById('pin-dialog');
const pinTitle   = document.getElementById('pin-title');
const pinSubtitle = document.getElementById('pin-subtitle');
const pinInput   = document.getElementById('pin-input');
const pinError   = document.getElementById('pin-error');
const pinCancel  = document.getElementById('pin-cancel');
const pinConfirm = document.getElementById('pin-confirm');

function showPinDialog(title, subtitle) {
  return new Promise((resolve) => {
    pinTitle.textContent = title;
    pinSubtitle.textContent = subtitle;
    pinInput.value = '';
    pinError.classList.add('hidden');
    pinOverlay.classList.remove('hidden');
    pinDialog.classList.remove('hidden');
    setTimeout(() => pinInput.focus(), 100);

    const cleanup = () => {
      pinOverlay.classList.add('hidden');
      pinDialog.classList.add('hidden');
      pinConfirm.onclick = null;
      pinCancel.onclick = null;
      pinOverlay.onclick = null;
      pinInput.onkeydown = null;
    };

    pinConfirm.onclick = () => {
      const val = pinInput.value.trim();
      if (!/^\d{4,6}$/.test(val)) {
        pinError.textContent = 'PIN must be 4\u20136 digits';
        pinError.classList.remove('hidden');
        return;
      }
      cleanup();
      resolve(val);
    };

    pinInput.onkeydown = (e) => {
      if (e.key === 'Enter') pinConfirm.onclick();
    };

    pinCancel.onclick  = () => { cleanup(); resolve(null); };
    pinOverlay.onclick = () => { cleanup(); resolve(null); };
  });
}

// ---------------------------------------------------------------------------
// Share Config (encrypt + copy URL)
// ---------------------------------------------------------------------------

const shareConfigBtn = document.getElementById('share-config-btn');

shareConfigBtn.addEventListener('click', async () => {
  const o = getOpenaiKey();
  const a = getAnthropicKey();
  const w = getWorkerUrl();

  if (!o && !a && !w) {
    showToast('No credentials to share', true);
    return;
  }

  if (!window.crypto || !crypto.subtle) {
    showToast('HTTPS required for encryption', true);
    return;
  }

  const pin = await showPinDialog(
    'Create a PIN',
    'Choose a 4\u20136 digit PIN to protect your config. Share the PIN separately with the recipient.'
  );
  if (!pin) return;

  try {
    const payload = await encryptConfig({ o, a, w }, pin);
    const url = `${location.origin}${location.pathname}#config=${payload}`;

    let copied = false;
    try { await navigator.clipboard.writeText(url); copied = true; } catch {}
    if (!copied) {
      const tmp = document.createElement('textarea');
      tmp.value = url;
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);
    }

    showToast('Config link copied! Share it with your PIN.');
  } catch (err) {
    console.error('Encrypt failed:', err);
    showToast('Encryption failed', true);
  }
});

// ---------------------------------------------------------------------------
// Config import (decrypt from URL hash)
// ---------------------------------------------------------------------------

async function handleConfigImport(payload) {
  if (!window.crypto || !crypto.subtle) {
    showToast('HTTPS required for decryption', true);
    return;
  }

  while (true) {
    const pin = await showPinDialog(
      'Enter PIN',
      'Enter the PIN you received to unlock the configuration.'
    );
    if (!pin) return; // cancelled

    try {
      const config = await decryptConfig(payload, pin);
      if (config.o) localStorage.setItem('ccscribe_openai_key', config.o);
      if (config.a) localStorage.setItem('ccscribe_anthropic_key', config.a);
      if (config.w) localStorage.setItem('ccscribe_worker_url', config.w);
      loadSettings();
      showToast('Configuration loaded successfully!');
      return;
    } catch {
      // Wrong PIN — show error inline, loop to retry
      pinError.textContent = 'Wrong PIN or corrupted data. Try again.';
      pinError.classList.remove('hidden');
      pinOverlay.classList.remove('hidden');
      pinDialog.classList.remove('hidden');
    }
  }
}

// ---------------------------------------------------------------------------
// Settings (localStorage)
// ---------------------------------------------------------------------------

function loadSettings() {
  openaiKeyInput.value    = localStorage.getItem('ccscribe_openai_key') || '';
  anthropicKeyInput.value = localStorage.getItem('ccscribe_anthropic_key') || '';
  workerUrlInput.value    = localStorage.getItem('ccscribe_worker_url') || '';
  supabaseUrlInput.value  = localStorage.getItem('ccscribe_supabase_url') || SUPABASE_DEFAULT_URL;
  supabaseKeyInput.value  = localStorage.getItem('ccscribe_supabase_key') || SUPABASE_DEFAULT_KEY;

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
    const parts = text.split(wrong);
    if (parts.length > 1) {
      correctionHits.set(wrong, (correctionHits.get(wrong) || 0) + parts.length - 1);
      text = parts.join(correct);
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

    // 4. Claude translation (skip if no EN/PL needed on any display)
    const needsTranslation = showEn.checked || showPl.checked || liveEn.checked || livePl.checked;
    let english = '', polish = '';
    if (needsTranslation) {
      ({ english, polish } = await callClaude(chinese));
    }

    // 5. Build segment
    const segment = {
      id: ++segId,
      chinese,
      english,
      polish,
      start_time: elapsedSec,
    };
    segments.push(segment);
    persistSession();

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
    if (ev.data.size > 0 && recording) {
      // Fire-and-forget: process concurrently
      processChunk(ev.data);
    }
  };

  rec.onstop = () => {
    if (recording) {
      recorder = createRecorder();
      recorder.start();
      setTimeout(() => {
        if (recording && recorder.state === 'recording') {
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
    if (recording && recorder.state === 'recording') {
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
  correctionHits = new Map();

  // Start recording cycle
  startRecorderCycle();
  recording = true;

  // UI
  recBtn.classList.add('recording');
  recLabel.textContent = 'STOP';
  clearBtn.disabled = true;
  saveBtn.disabled = true;
  shareBtn.disabled = false;

  // Elapsed timer
  elapsedSec = 0;
  elapsedEl.textContent = '00:00';
  elapsedTimer = setInterval(() => {
    elapsedSec++;
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    elapsedEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

  // Upload transcript and correction stats to Supabase
  uploadTranscript();
  uploadCorrectionStats();

  // UI
  recBtn.classList.remove('recording');
  recLabel.textContent = 'START';
  clearBtn.disabled = segments.length === 0;
  saveBtn.disabled = segments.length === 0;
  levelFill.style.width = '0%';
}

function clearTranscript() {
  if (recording) return;
  if (!confirm('Clear all transcription text? This cannot be undone.')) return;

  segments = [];
  segId = 0;
  sessionId = null;
  elapsedSec = 0;
  elapsedEl.textContent = '00:00';
  feed.innerHTML = '';

  // Clear persisted session
  localStorage.removeItem('ccscribe_segments');
  localStorage.removeItem('ccscribe_segId');
  localStorage.removeItem('ccscribe_sessionId');
  localStorage.removeItem('ccscribe_elapsedSec');

  // UI
  clearBtn.disabled = true;
  saveBtn.disabled = true;
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
  const url = (supabaseUrlInput ? supabaseUrlInput.value.trim() : '') || SUPABASE_DEFAULT_URL;
  const key = (supabaseKeyInput ? supabaseKeyInput.value.trim() : '') || SUPABASE_DEFAULT_KEY;
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

async function uploadCorrectionStats() {
  if (!supabaseClient || !sessionId || correctionHits.size === 0) return;
  try {
    await supabaseClient.from('correction_stats').upsert({
      session_id: sessionId,
      stats: Object.fromEntries(correctionHits),
    }, { onConflict: 'session_id' });
    console.log(`Correction stats uploaded: ${correctionHits.size} terms`);
  } catch (e) {
    console.warn('Correction stats upload failed:', e);
  }
}

window.glossaryStats = async function(top = 30) {
  // Show current session stats
  if (correctionHits.size > 0) {
    const session = [...correctionHits.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n=== Current session: ${session.length} terms corrected ===`);
    console.table(session.slice(0, top).map(([wrong, count]) => ({ wrong, count })));
  }

  // Show cumulative stats from Supabase
  if (!supabaseClient) { console.log('Supabase not configured — showing session stats only'); return; }
  try {
    const { data, error } = await supabaseClient.from('correction_stats').select('stats');
    if (error) throw error;
    const totals = {};
    for (const row of data) {
      for (const [term, count] of Object.entries(row.stats)) {
        totals[term] = (totals[term] || 0) + count;
      }
    }
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    console.log(`\n=== All talks: ${data.length} sessions, ${sorted.length} unique terms ===`);
    console.table(sorted.slice(0, top).map(([wrong, count]) => ({ wrong, count, sessions: data.filter(r => r.stats[wrong]).length })));
  } catch (e) {
    console.warn('Failed to fetch cumulative stats:', e);
  }
};

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

clearBtn.addEventListener('click', clearTranscript);
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
  restoreSession();
  await loadGlossary();
  initSupabase();

  // Check for encrypted config in URL hash
  if (location.hash.startsWith('#config=')) {
    const payload = location.hash.slice('#config='.length);
    history.replaceState(null, '', location.pathname + location.search);
    await handleConfigImport(payload);
  }

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
