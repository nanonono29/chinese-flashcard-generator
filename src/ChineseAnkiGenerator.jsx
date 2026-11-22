import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  BookOpen, Volume2, Edit3, Check, AlertTriangle, Trash2, Plus, 
  Download, RefreshCw, Play, Pause, History, Search, ChevronDown, 
  ChevronUp, CheckCircle2, Info, Sparkles, FileCheck, Layers, 
  RotateCcw, ShieldAlert, Upload, HelpCircle, Eye, EyeOff, Key
} from 'lucide-react';

// ============================================================================
// ISOLATED GEMINI API SERVICE LAYER (EASY TO SWAP TO A BACKEND PROXY LATER)
// ============================================================================
// To migrate to a backend later, replace the implementations inside
// `geminiService.generateTextJson` and `geminiService.generateTtsAudio`
// with `fetch('/api/generate', ...)` and `fetch('/api/tts', ...)` calls.
// None of the React UI components or state logic will need to be rewritten.

const geminiService = {
  /**
   * Calls Gemini text generation using the provided session API key.
   * Future backend migration: point `endpoint` to your backend route and omit `apiKey`.
   */
  async generateTextJson({ apiKey, prompt }) {
    const trimmedKey = (apiKey || '').trim();
    if (!trimmedKey) {
      throw new Error(
        'A Gemini API key is required before generating flashcards. Enter your key in the Gemini API Key bar at the top of the page.'
      );
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${encodeURIComponent(
      trimmedKey
    )}`;

    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      })
    });

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const cleanedJson = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleanedJson);
  },

  /**
   * Calls Gemini Mandarin TTS using the provided session API key.
   * Future backend migration: point `endpoint` to your backend TTS route and omit `apiKey`.
   */
  async generateTtsAudio({ apiKey, text }) {
    const trimmedKey = (apiKey || '').trim();
    if (!trimmedKey) {
      throw new Error(
        'A Gemini API key is required before generating Mandarin audio. Enter your key in the Gemini API Key bar at the top of the page.'
      );
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(
      trimmedKey
    )}`;

    const payload = {
      contents: [
        {
          parts: [
            {
              text: `Speak clearly in standard Mandarin Chinese at a natural, learner-friendly pace: ${text}`
            }
          ]
        }
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Aoede' }
          }
        }
      },
      model: 'gemini-2.5-flash-preview-tts'
    };

    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    const part = result?.candidates?.[0]?.content?.parts?.[0];
    const audioData = part?.inlineData?.data;
    const mimeType = part?.inlineData?.mimeType;

    if (!audioData || !mimeType || !mimeType.startsWith('audio/')) {
      throw new Error('TTS service did not return valid Mandarin audio data.');
    }

    return { audioData, mimeType };
  },

  /**
   * Fetches a standard Mandarin MP3 audio file (no Gemini API call / zero Gemini quota)
   * so Standard Mandarin TTS mode can also embed genuine playable audio files in .apkg exports.
   */
  async generateStandardTtsBlob({ text, lang = 'zh-CN' }) {
    const cleanText = (text || '').trim();
    if (!cleanText) throw new Error('No Chinese text provided for Standard TTS.');
    const targetLang = lang && lang.toLowerCase().startsWith('zh-tw') ? 'zh-TW' : 'zh-CN';
    const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(
      targetLang
    )}&q=${encodeURIComponent(cleanText)}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Standard TTS file download failed (HTTP ${response.status}).`);
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) {
      throw new Error('Standard TTS returned an empty audio file.');
    }
    return { blob, ext: 'mp3' };
  }
};

// ============================================================================
// UTILITY FUNCTIONS: AUDIO CONVERSION (PCM16 -> WAV) & RETRY HELPER
// ============================================================================
// UTILITY FUNCTIONS: AUDIO CONVERSION (PCM16 -> WAV) & GEMINI API HELPERS
// ============================================================================

function base64ToArrayBuffer(base64) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function pcmToWav(pcm16, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm16.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i++, offset += 2) {
    view.setInt16(offset, pcm16[i], true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function fetchWithRetry(url, options, maxRetries = 4) {
  let delay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status === 429 || response.status >= 500) {
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2;
        continue;
      }
      const errText = await response.text();
      throw new Error(`API Error (${response.status}): ${errText}`);
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await new Promise((res) => setTimeout(res, delay));
      delay *= 2;
    }
  }
}

// ============================================================================
// DYNAMIC LIBRARY LOADER FOR GENUINE .APKG GENERATION (SQL.JS + JSZIP)
// ============================================================================

const loadExternalScript = (src) => {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
};

async function ensureAnkiLibraries() {
  await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js');
  if (!window.__sqlInstance) {
    window.__sqlInstance = await window.initSqlJs({
      locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
    });
  }
  return { SQL: window.__sqlInstance, JSZip: window.JSZip };
}

// ============================================================================
// STRICT MIXED-INPUT PARSER IMPLEMENTATION
// ============================================================================

/**
 * Ensures Chinese sentences end with appropriate full-width Chinese punctuation (。, ？, ！)
 * without duplicating existing ending punctuation.
 */
function ensureChineseEndingPunctuation(sentence) {
  if (!sentence) return '';
  const trimmed = sentence.trim();
  if (!trimmed) return '';

  // Only apply if the sentence contains Chinese characters
  if (!/[\u4e00-\u9fff]/.test(trimmed)) return trimmed;

  // Check if it already ends with standard or full-width sentence-ending punctuation (including closing quotes/brackets after punctuation)
  if (/[。！？；.!?;…]+["”’」』）)]*$/.test(trimmed)) {
    return trimmed;
  }

  // Strip any trailing half-width/full-width comma before appending proper ending punctuation
  const cleaned = trimmed.replace(/[,，、]+$/, '');

  // Detect Chinese interrogative particles, question words, or A-not-A patterns
  const isQuestion =
    /(吗|呢|吧|么)[”’」』]?$/.test(cleaned) ||
    /(什么|谁|哪|哪里|哪儿|怎么|怎么样|为什么|多少|几|是否|难道|岂)/.test(cleaned) ||
    /([\u4e00-\u9fff])[不没]\1/.test(cleaned);

  return cleaned + (isQuestion ? '？' : '。');
}

/**
 * Parses mixed Chinese vocabulary chunks and parenthesized custom sentences
 * strictly following the user's specification:
 * - Newlines separate entries. Commas are NEVER used as separators.
 * - A substring containing (...) or （...） is a custom sentence entry.
 * - Spaces outside the sentence separate individual vocabulary chunks, even on the same line!
 *   Example: "我喜欢（吃饭）。 其实" -> Sentence: "我喜欢吃饭。" (Target: "吃饭"), plus chunk "其实".
 */
function parseMixedChineseInput(rawText, historyMap = {}) {
  const lines = rawText.split(/\r?\n/);
  const rawItems = []; // { id, type: 'vocab' | 'custom_sentence', chunk, sentence?, cleanSentence?, rawLine, lineNum, issue? }
  let itemIdCounter = 1;

  lines.forEach((originalLine, lineIdx) => {
    const trimmedLine = originalLine.trim();
    if (!trimmedLine) return; // Ignore empty lines

    // Regex to match a contiguous sentence unit containing (...) or （...） without whitespace inside/around unless part of sentence
    // Let's handle sentences that might contain internal spaces (e.g. "我 喜欢 (吃饭)。") vs trailing space-separated vocab ("我喜欢（吃饭）。 其实")
    // Strategy: Locate any parenthesized segment `[(（]([^)）]+)[)）]`.
    // Wait: What if a line is "我喜欢（吃饭）。 其实"?
    // Notice "我喜欢（吃饭）。" has punctuation at the end, followed by space, followed by "其实".
    // What if a line is "今天天气真好 我喜欢（吃饭）。 明天见"?
    // Let's check: A sentence containing parentheses has text immediately attached to the parentheses (no space) or punctuation attached to it, whereas separate vocab chunks are separated by spaces!
    // Even better: What if the user wrote spaces INSIDE a custom sentence like "我 喜欢 (吃饭)。"?
    // If there are parentheses on the line:
    // Let's tokenize by whitespace, and group tokens that belong to the sentence clause (the token with parentheses plus any adjacent tokens that don't stand alone as separate vocab, OR specifically: tokens directly attached or punctuated).
    // Let's test both cases carefully!
    // Case A: "我喜欢（吃饭）。 其实" -> tokens: ["我喜欢（吃饭）。", "其实"] -> token 0 has parens, token 1 does not -> token 0 is sentence, token 1 is vocab!
    // Case B: "其实 我喜欢（吃饭）。 包子" -> tokens: ["其实", "我喜欢（吃饭）。", "包子"] -> "其实" (vocab), "我喜欢（吃饭）。" (sentence), "包子" (vocab).
    // Case C: "I like (eating) food. 吃饭" -> If someone puts spaces inside their custom sentence, how do we distinguish "I like (eating) food." from "我喜欢（吃饭）。 其实"?
    // Look at the user's rule:
    // "If there is a pair of full-width Chinese parentheses （ ） or standard parentheses ( ), treat the entire line as a custom sentence entry. Preserve all spaces and punctuation inside custom sentence lines. Do not split custom sentence lines into individual vocabulary chunks."
    // AND under Mixed input parsing rules:
    // "Text separated from a custom sentence by spaces must still be parsed as separate vocabulary chunks."
    // Example given:
    // `我喜欢（吃饭）。 其实` -> Sentence: `我喜欢吃饭。`, Target: `吃饭`, plus Vocabulary chunk: `其实`.
    // Look at why `其实` is separate: `我喜欢（吃饭）。` ends with sentence-ending punctuation (`。`, `！`, `？`, `.`, `!`, `?`, `；`, `;`) or has no spaces inside the Chinese sentence, whereas `其实` is separated by a space!
    // What if there's NO period, e.g., `其实 我喜欢（吃饭） 包子`? Here `我喜欢（吃饭）` is one space-delimited token containing parentheses, while `其实` and `包子` are separate space-delimited tokens without parentheses!
    // What if a custom sentence DOES have spaces inside it, e.g. `我 喜欢 （吃饭）。 其实`? The sentence ends at `。`!
    // Let's combine these cleanly:
    // 1. Check if the line has any `(` `)` `（` `）`.
    if (!/[()（）]/.test(trimmedLine)) {
      // Pure vocabulary line: split strictly by whitespace (NEVER by commas)
      const chunks = trimmedLine.split(/\s+/).filter(Boolean);
      chunks.forEach((chunk) => {
        rawItems.push({
          id: `item-${itemIdCounter++}`,
          type: 'vocab',
          chunk,
          cleanSentence: null,
          lineNum: lineIdx + 1,
          issue: validateChunkFormat(chunk)
        });
      });
      return;
    }

    // Line contains parentheses. Let's scan through segments separated by whitespace,
    // while keeping sentence segments intact if they end with sentence punctuation or contain parentheses.
    // Specifically: If we split by whitespace into tokens:
    // Any token containing `(` or `（` or `)` or `）` is definitely part of the custom sentence.
    // What if a custom sentence has internal spaces before sentence-ending punctuation, like `他 说 (没关系) 。 其实`?
    // If a token has parentheses, and subsequent tokens lead up to sentence-ending punctuation (`。！？.!?`), group them until the punctuation! Otherwise, a single space-separated token containing parentheses is the custom sentence, and tokens separated by spaces before/after it are standalone vocabulary chunks!
    const tokens = trimmedLine.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      const hasParen = /[()（）]/.test(token);

      if (!hasParen) {
        // Check if this token is just trailing punctuation attached after space to previous sentence
        rawItems.push({
          id: `item-${itemIdCounter++}`,
          type: 'vocab',
          chunk: token,
          cleanSentence: null,
          lineNum: lineIdx + 1,
          issue: validateChunkFormat(token)
        });
        i++;
      } else {
        // This token has parentheses. Check if parentheses are unclosed in this token (e.g. "(吃饭 开心)")
        let sentenceTokens = [token];
        let openCount = (token.match(/[(（]/g) || []).length;
        let closeCount = (token.match(/[)）]/g) || []).length;

        while (openCount > closeCount && i + 1 < tokens.length) {
          i++;
          sentenceTokens.push(tokens[i]);
          openCount += (tokens[i].match(/[(（]/g) || []).length;
          closeCount += (tokens[i].match(/[)）]/g) || []).length;
        }

        const rawSentence = sentenceTokens.join(' ');
        const parsedSent = extractSentenceAndTarget(rawSentence, lineIdx + 1);
        rawItems.push({
          id: `item-${itemIdCounter++}`,
          type: 'custom_sentence',
          ...parsedSent,
          lineNum: lineIdx + 1
        });
        i++;
      }
    }
  });

  // Now aggregate unique vocabulary chunks while preserving order and tracking duplicates & custom sentences
  const uniqueMap = new Map();
  const duplicateEvents = [];
  const invalidEntries = [];

  rawItems.forEach((item) => {
    if (item.issue) {
      invalidEntries.push(item);
    }

    const key = item.chunk;
    if (!key) return;

    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, {
        id: `vocab-${uniqueMap.size + 1}-${Date.now()}`,
        chunk: key,
        occurrences: 1,
        customSentences: item.type === 'custom_sentence' && !item.issue ? [item.cleanSentence] : [],
        hasCustomSentence: item.type === 'custom_sentence' && !item.issue,
        inHistory: Boolean(historyMap[key]),
        historyDate: historyMap[key]?.createdAt || null,
        skipGeneration: false,
        issue: item.issue || null,
        lineNums: [item.lineNum]
      });
    } else {
      const existing = uniqueMap.get(key);
      existing.occurrences += 1;
      existing.lineNums.push(item.lineNum);
      if (item.type === 'custom_sentence' && !item.issue) {
        existing.customSentences.push(item.cleanSentence);
        existing.hasCustomSentence = true;
      }
      duplicateEvents.push({
        chunk: key,
        lineNum: item.lineNum,
        sourceType: item.type
      });
    }
  });

  return {
    rawItems,
    uniqueEntries: Array.from(uniqueMap.values()),
    duplicateEvents,
    invalidEntries
  };
}

function validateChunkFormat(chunk) {
  if (!chunk || chunk.trim().length === 0) return 'Empty entry';
  if (/[,，、]/.test(chunk)) {
    return 'Contains comma/enumeration mark (commas are not separators; check if multiple words were pasted together)';
  }
  if (!/[\u4e00-\u9fff]/.test(chunk)) {
    return 'No Chinese characters detected in this chunk';
  }
  return null;
}

function extractSentenceAndTarget(rawSentence, lineNum) {
  // Match first pair of (...) or （...）
  const match = rawSentence.match(/[(（]([^()（）]+)[)）]/);
  const allParens = rawSentence.match(/[(（][^()（）]*[)）]/g) || [];

  if (!match) {
    return {
      chunk: rawSentence.replace(/[()（）]/g, '').trim(),
      cleanSentence: rawSentence.replace(/[()（）]/g, '').trim(),
      rawSentence,
      issue: `Line ${lineNum}: Mismatched or empty parentheses in "${rawSentence}"`
    };
  }

  const target = match[1].trim();
  // Remove parentheses around target when creating the actual sentence, then ensure proper Chinese ending punctuation
  const rawClean = rawSentence.replace(/[(（]([^()（）]+)[)）]/g, '$1').trim();
  const cleanSentence = ensureChineseEndingPunctuation(rawClean);

  let issue = null;
  if (!target) {
    issue = `Line ${lineNum}: Empty parentheses in "${rawSentence}"`;
  } else if (!/[\u4e00-\u9fff]/.test(target)) {
    issue = `Line ${lineNum}: Target "${target}" inside parentheses has no Chinese characters`;
  } else if (allParens.length > 1) {
    issue = `Line ${lineNum}: Multiple parenthesized targets found in one sentence; only the first ("${target}") was extracted`;
  }

  return {
    chunk: target,
    cleanSentence,
    rawSentence,
    issue
  };
}

// ============================================================================
// ANKI .APKG PACKAGE GENERATOR (GENUINE SQLITE COLLECTION + MEDIA ZIP)
// ============================================================================

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

function ankiChecksum(str) {
  // Simple numeric hash for Anki's csum field (first 8 hex digits of SHA1 as integer)
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function generateGuid() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
  let res = '';
  for (let i = 0; i < 10; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

/**
 * Builds a genuine Anki 2.1 .apkg file containing:
 * - Two custom Note Types (Models):
 *   1. "Chinese Vocab - Sentence Cloze" (Genuine Anki Cloze note type: type = 1, {{c1::target}}, {{cloze:Text}})
 *   2. "Chinese Vocab - Word Recognition" (Standard note type: type = 0, Front: Target Chinese chunk ONLY)
 * - Embedded WAV audio files mapped in the `media` JSON manifest.
 */
async function buildGenuineApkg(cardsData, deckName, audioStore) {
  const { SQL, JSZip } = await ensureAnkiLibraries();
  const db = new SQL.Database();

  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const deckId = nowMs;
  const clozeModelId = nowMs + 101;
  const recogModelId = nowMs + 202;

  // Create Anki SQLite schema
  db.run(`
    CREATE TABLE col (
      id integer primary key, crt integer not null, mod integer not null, scm integer not null,
      ver integer not null, dty integer not null, usn integer not null, ls integer not null,
      conf text not null, models text not null, decks text not null, dconf text not null, tags text not null
    );
    CREATE TABLE notes (
      id integer primary key, guid text not null, mid integer not null, mod integer not null,
      usn integer not null, tags text not null, flds text not null, sfld text not null,
      csum integer not null, flags integer not null, data text not null
    );
    CREATE TABLE cards (
      id integer primary key, nid integer not null, did integer not null, ord integer not null,
      mod integer not null, usn integer not null, type integer not null, queue integer not null,
      due integer not null, ivl integer not null, factor integer not null, reps integer not null,
      lapses integer not null, left integer not null, odue integer not null, odid integer not null,
      flags integer not null, data text not null
    );
    CREATE TABLE revlog (
      id integer primary key, cid integer not null, usn integer not null, ease integer not null,
      ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null
    );
    CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
  `);

  const sharedCss = `
    .card {
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 20px;
      text-align: center;
      color: #1e293b;
      background-color: #ffffff;
      line-height: 1.6;
      padding: 24px 16px;
    }
    .nightMode .card {
      color: #f1f5f9;
      background-color: #0f172a;
    }
    .cloze {
      font-weight: 700;
      color: #0284c7;
    }
    .nightMode .cloze {
      color: #38bdf8;
    }
    .target-word {
      font-size: 44px;
      font-weight: 700;
      color: #0f172a;
      margin: 12px 0 4px;
    }
    .nightMode .target-word { color: #f8fafc; }
    .pinyin {
      font-size: 20px;
      color: #0284c7;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .nightMode .pinyin { color: #38bdf8; }
    .definition {
      font-size: 19px;
      color: #334155;
      font-weight: 500;
      margin-bottom: 16px;
    }
    .nightMode .definition { color: #cbd5e1; }
    .sentence-cn {
      font-size: 26px;
      font-weight: 600;
      margin: 16px 0 6px;
      color: #0f172a;
    }
    .nightMode .sentence-cn { color: #f8fafc; }
    .hint-box {
      display: inline-block;
      margin-top: 14px;
      padding: 6px 14px;
      background: #f1f5f9;
      border-radius: 8px;
      font-size: 16px;
      color: #475569;
    }
    .nightMode .hint-box { background: #1e293b; color: #94a3b8; }
    .sentence-py {
      font-size: 16px;
      color: #64748b;
      margin-bottom: 4px;
    }
    .sentence-en {
      font-size: 17px;
      color: #334155;
      font-style: italic;
      margin-bottom: 14px;
    }
    .nightMode .sentence-en { color: #cbd5e1; }
    .components-box {
      text-align: left;
      max-width: 540px;
      margin: 16px auto;
      padding: 12px 16px;
      background: #f8fafc;
      border-left: 4px solid #0284c7;
      border-radius: 6px;
      font-size: 15px;
      line-height: 1.55;
    }
    .nightMode .components-box { background: #1e293b; color: #e2e8f0; }
    .audio-row { margin-top: 12px; font-size: 14px; color: #64748b; }
    hr#answer { border: 0; border-top: 1px solid #e2e8f0; margin: 18px 0; }
  `;

  // Model 1: Genuine Anki Cloze Model (type: 1)
  // Fields: 0:Text (contains {{c1::target}}), 1:Hint, 2:TargetChunk, 3:ChunkPinyin, 4:Definition, 5:FullSentence, 6:SentencePinyin, 7:SentenceTranslation, 8:TermAudio, 9:SentenceAudio
  const clozeModel = {
    id: clozeModelId,
    name: 'Chinese Vocab - Sentence Cloze',
    type: 1,
    mod: nowSec,
    usn: -1,
    sortf: 2,
    did: deckId,
    tmpls: [
      {
        name: 'Cloze',
        ord: 0,
        qfmt: `
          <div class="sentence-cn">{{cloze:Text}}</div>
          <div class="hint-box">Hint: {{Hint}}</div>
        `,
        afmt: `
          <div class="sentence-cn">{{cloze:Text}}</div>
          <hr id="answer">
          <div class="target-word">{{TargetChunk}}</div>
          <div class="pinyin">{{ChunkPinyin}}</div>
          <div class="definition">{{Definition}}</div>
          <div class="audio-row">{{TermAudio}}</div>
          <div class="sentence-py">{{SentencePinyin}}</div>
          <div class="sentence-en">{{SentenceTranslation}}</div>
          <div class="audio-row">{{SentenceAudio}}</div>
        `,
        bqfmt: '',
        bafmt: '',
        did: null,
        bfont: '',
        bsize: 0
      }
    ],
    flds: [
      'Text', 'Hint', 'TargetChunk', 'ChunkPinyin', 'Definition',
      'FullSentence', 'SentencePinyin', 'SentenceTranslation', 'TermAudio', 'SentenceAudio'
    ].map((name, ord) => ({
      name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: []
    })),
    css: sharedCss,
    latexPre: '',
    latexPost: '',
    latexsvg: false,
    req: [[0, 'any', [0]]]
  };

  // Model 2: Word Recognition Model (type: 0)
  // Fields: 0:TargetChunk, 1:ChunkPinyin, 2:Definition, 3:ComponentBreakdown, 4:FullSentence, 5:SentencePinyin, 6:SentenceTranslation, 7:TermAudio, 8:SentenceAudio
  const recogModel = {
    id: recogModelId,
    name: 'Chinese Vocab - Word Recognition',
    type: 0,
    mod: nowSec,
    usn: -1,
    sortf: 0,
    did: deckId,
    tmpls: [
      {
        name: 'Word Recognition',
        ord: 0,
        qfmt: `
          <div class="target-word">{{TargetChunk}}</div>
        `,
        afmt: `
          <div class="target-word">{{TargetChunk}}</div>
          <div class="pinyin">{{ChunkPinyin}}</div>
          <div class="definition">{{Definition}}</div>
          <div class="audio-row">{{TermAudio}}</div>
          <hr id="answer">
          <div class="components-box"><strong>Character Components:</strong><br>{{ComponentBreakdown}}</div>
          <div class="sentence-cn">{{FullSentence}}</div>
          <div class="sentence-py">{{SentencePinyin}}</div>
          <div class="sentence-en">{{SentenceTranslation}}</div>
          <div class="audio-row">{{SentenceAudio}}</div>
        `,
        bqfmt: '',
        bafmt: '',
        did: null,
        bfont: '',
        bsize: 0
      }
    ],
    flds: [
      'TargetChunk', 'ChunkPinyin', 'Definition', 'ComponentBreakdown',
      'FullSentence', 'SentencePinyin', 'SentenceTranslation', 'TermAudio', 'SentenceAudio'
    ].map((name, ord) => ({
      name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: []
    })),
    css: sharedCss,
    latexPre: '',
    latexPost: '',
    latexsvg: false,
    req: [[0, 'all', [0]]]
  };

  const models = {
    [clozeModelId]: clozeModel,
    [recogModelId]: recogModel
  };

  const decks = {
    1: {
      id: 1, name: 'Default', mod: nowSec, usn: -1, lrnToday: [0, 0], revToday: [0, 0],
      newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: false,
      desc: '', dyn: 0, conf: 1, extendNew: 10, extendRev: 50
    },
    [deckId]: {
      id: deckId, name: deckName || 'Chinese Vocabulary', mod: nowSec, usn: -1,
      lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
      collapsed: false, browserCollapsed: false,
      desc: 'Generated by Chinese Flashcard Generator',
      dyn: 0, conf: 1, extendNew: 10, extendRev: 50
    }
  };

  const dconf = {
    1: {
      id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true,
      new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20 },
      rev: { bury: false, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
      lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 }
    }
  };

  const conf = {
    nextPos: 1, estTimes: true, activeDecks: [deckId], sortType: 'noteFld', timeLim: 0,
    sortBackwards: false, addToCur: true, curDeck: deckId, newBury: true, newSpread: 0,
    dueCounts: true, curModel: String(clozeModelId), collapseTime: 1200
  };

  db.run(
    `INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, nowSec, nowSec, nowMs, 11, 0, 0, 0, JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}']
  );

  // Prepare media zip & SQLite note/card inserts
  const zip = new JSZip();
  const mediaManifest = {};
  let mediaIndex = 0;

  const insertNoteStmt = db.prepare(`INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertCardStmt = db.prepare(`INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let noteIdCounter = nowMs + 1000;
  let cardIdCounter = nowMs + 50000;
  let dueCounter = 1;

  for (const item of cardsData) {
    const hasCloze = !item.deletedCloze;
    const hasRecog = !item.deletedRecognition;
    if (!hasCloze && !hasRecog) continue;

    // Attach audio files if available in audioStore
    let termAudioTag = '';
    let sentAudioTag = '';

    const wordAudioBlob = audioStore[item.wordAudioKey]?.blob;
    if (wordAudioBlob) {
      const ext = audioStore[item.wordAudioKey]?.ext || 'wav';
      const fileName = `zh_term_${item.id}.${ext}`;
      const mediaIdxStr = String(mediaIndex++);
      mediaManifest[mediaIdxStr] = fileName;
      const arrBuf = await wordAudioBlob.arrayBuffer();
      zip.file(mediaIdxStr, arrBuf);
      termAudioTag = `[sound:${fileName}]`;
    }

    const sentAudioBlob = audioStore[item.sentenceAudioKey]?.blob;
    if (sentAudioBlob) {
      const ext = audioStore[item.sentenceAudioKey]?.ext || 'wav';
      const fileName = `zh_sent_${item.id}.${ext}`;
      const mediaIdxStr = String(mediaIndex++);
      mediaManifest[mediaIdxStr] = fileName;
      const arrBuf = await sentAudioBlob.arrayBuffer();
      zip.file(mediaIdxStr, arrBuf);
      sentAudioTag = `[sound:${fileName}]`;
    }

    // 1. Insert Genuine Cloze Note + Card if not deleted (ord = 0 corresponds to c1)
    if (hasCloze) {
      const ankiClozeTextField = buildAnkiClozeField(item.cloze.sentence, item.cloze.target);
      const clozeFields = [
        ankiClozeTextField,
        escapeHtml(item.cloze.hint),
        escapeHtml(item.cloze.target),
        escapeHtml(item.cloze.pinyin),
        escapeHtml(item.cloze.definition),
        escapeHtml(item.cloze.sentence),
        escapeHtml(item.cloze.sentencePinyin),
        escapeHtml(item.cloze.sentenceTranslation),
        termAudioTag,
        sentAudioTag
      ].join('\x1f');

      const clozeNoteId = noteIdCounter++;
      insertNoteStmt.run([
        clozeNoteId, generateGuid(), clozeModelId, nowSec, -1,
        'chinese-vocab cloze', clozeFields, item.cloze.target,
        ankiChecksum(item.cloze.target + '_cloze'), 0, ''
      ]);
      insertCardStmt.run([
        cardIdCounter++, clozeNoteId, deckId, 0, nowSec, -1,
        0, 0, dueCounter++, 0, 0, 0, 0, 0, 0, 0, 0, ''
      ]);
    }

    // 2. Insert Word Recognition Note + Card if not deleted
    if (hasRecog) {
      const componentsHtml = item.recognition.components
        .map((c) => `<b>${escapeHtml(c.char)}</b>: ${escapeHtml(c.explanation)}`)
        .join('<br>');

      const recogFields = [
        escapeHtml(item.recognition.target),
        escapeHtml(item.recognition.pinyin),
        escapeHtml(item.recognition.definition),
        componentsHtml,
        escapeHtml(item.recognition.sentence),
        escapeHtml(item.recognition.sentencePinyin),
        escapeHtml(item.recognition.sentenceTranslation),
        termAudioTag,
        sentAudioTag
      ].join('\x1f');

      const recogNoteId = noteIdCounter++;
      insertNoteStmt.run([
        recogNoteId, generateGuid(), recogModelId, nowSec, -1,
        'chinese-vocab recognition', recogFields, item.recognition.target,
        ankiChecksum(item.recognition.target + '_recog'), 0, ''
      ]);
      insertCardStmt.run([
        cardIdCounter++, recogNoteId, deckId, 0, nowSec, -1,
        0, 0, dueCounter++, 0, 0, 0, 0, 0, 0, 0, 0, ''
      ]);
    }
  }

  insertNoteStmt.free();
  insertCardStmt.free();

  const dbBinaryArray = db.export();
  zip.file('collection.anki2', dbBinaryArray);
  zip.file('media', JSON.stringify(mediaManifest));

  const apkgBlob = await zip.generateAsync({ type: 'blob' });
  db.close();
  return apkgBlob;
}

/**
 * Formats the sentence for Anki's built-in Cloze note type using {{c1::target}} syntax.
 * Never inserts underscores, [...] placeholders, or HTML spans.
 */
function buildAnkiClozeField(sentence, target) {
  const cleanSentence = (sentence || '').trim();
  const cleanTarget = (target || '').trim();
  if (!cleanSentence) return cleanTarget ? `{{c1::${escapeHtml(cleanTarget)}}}` : '';
  if (!cleanTarget || !cleanSentence.includes(cleanTarget)) {
    return cleanTarget
      ? `${escapeHtml(cleanSentence)} {{c1::${escapeHtml(cleanTarget)}}}`
      : escapeHtml(cleanSentence);
  }
  const parts = cleanSentence.split(cleanTarget);
  return parts.map(escapeHtml).join(`{{c1::${escapeHtml(cleanTarget)}}}`);
}

// ============================================================================
// MAIN APPLICATION COMPONENT
// ============================================================================

const STORAGE_KEYS = {
  HISTORY: 'zh_anki_vocab_history_v1',
  SESSION_DRAFT: 'zh_anki_session_draft_v1',
  DECK_NAME: 'zh_anki_deck_name_v1'
};

const DEFAULT_SAMPLE_TEXT = `时间
所以
我喜欢（吃饭）。
包子`;

export default function App() {
  // Navigation Tabs: 'input' | 'review' | 'history'
  const [activeTab, setActiveTab] = useState('input');

  // Session-Memory-Only Gemini API Key (NEVER persisted to localStorage or source code)
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);

  // Stage 1: Mixed Input & Parsing State (starts empty when app first opens)
  const [rawInput, setRawInput] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SESSION_DRAFT);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.rawInput === 'string' && parsed.rawInput !== DEFAULT_SAMPLE_TEXT) {
          return parsed.rawInput;
        }
      }
    } catch (e) {}
    return '';
  });

  const [parsedState, setParsedState] = useState(null);
  const [parseError, setParseError] = useState('');

  // Stage 2: Generated Cards & Edit Tracking State
  const [cardsData, setCardsData] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SESSION_DRAFT);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.cardsData)) return parsed.cardsData;
      }
    } catch (e) {}
    return [];
  });

  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0, label: '' });
  const [globalError, setGlobalError] = useState('');
  const [hskLevel, setHskLevel] = useState('');

  // Stage 3: Audio Store (in-memory blobs & URLs)
  // key -> { url, blob, ext?: 'wav'|'mp3', sourceMethod?: 'ai'|'standard', status: 'idle'|'loading'|'ready'|'error', textSnapshot?: string, error?: string }
  const [audioStore, setAudioStore] = useState({});
  const [audioMethod, setAudioMethod] = useState('ai'); // 'ai' | 'standard'
  const [mandarinVoices, setMandarinVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useState('');
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [isGeneratingTermAudio, setIsGeneratingTermAudio] = useState(false);
  const [termAudioProgress, setTermAudioProgress] = useState({ current: 0, total: 0 });
  const [isGeneratingSentenceAudio, setIsGeneratingSentenceAudio] = useState(false);
  const [sentenceAudioProgress, setSentenceAudioProgress] = useState({ current: 0, total: 0 });
  const audioStoreRef = useRef({});
  const activeAudioRef = useRef(null);
  const [playingKey, setPlayingKey] = useState(null);

  useEffect(() => {
    audioStoreRef.current = audioStore;
  }, [audioStore]);

  // Detect available device Mandarin voices (zh-CN preferred, zh-TW fallback, never zh-HK or non-Chinese)
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setVoicesLoaded(true);
      return;
    }

    const loadMandarinVoices = () => {
      const allVoices = window.speechSynthesis.getVoices() || [];
      if (allVoices.length === 0) return;

      const zhCnVoices = allVoices.filter((v) => {
        const lang = (v.lang || '').toLowerCase().replace('_', '-');
        return lang === 'zh-cn' || lang.startsWith('zh-cn-') || lang === 'cmn-hans-cn';
      });

      const zhTwVoices = allVoices.filter((v) => {
        const lang = (v.lang || '').toLowerCase().replace('_', '-');
        return lang === 'zh-tw' || lang.startsWith('zh-tw-') || lang === 'cmn-hant-tw';
      });

      // Prefer zh-CN; allow zh-TW if zh-CN is unavailable; exclude zh-HK (Cantonese) and non-Chinese
      const compatible = zhCnVoices.length > 0 ? zhCnVoices : zhTwVoices;
      setMandarinVoices(compatible);
      setVoicesLoaded(true);

      setSelectedVoiceURI((prevUri) => {
        if (prevUri && compatible.some((v) => v.voiceURI === prevUri)) {
          return prevUri;
        }
        return compatible[0]?.voiceURI || '';
      });
    };

    loadMandarinVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadMandarinVoices);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', loadMandarinVoices);
    };
  }, []);

  const selectedMandarinVoice = useMemo(() => {
    return mandarinVoices.find((v) => v.voiceURI === selectedVoiceURI) || mandarinVoices[0] || null;
  }, [mandarinVoices, selectedVoiceURI]);

  const speakWithDeviceTts = (text, trackingKey = null) => {
    const cleanText = (text || '').trim();
    if (!cleanText) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setGlobalError('Standard Mandarin TTS is unavailable in this browser.');
      return;
    }
    if (!selectedMandarinVoice) {
      setGlobalError('No compatible Mandarin (zh-CN or zh-TW) voice is available on this device.');
      return;
    }

    try {
      window.speechSynthesis.cancel();
      if (activeAudioRef.current) {
        activeAudioRef.current.pause();
        activeAudioRef.current = null;
      }

      if (trackingKey && playingKey === trackingKey) {
        setPlayingKey(null);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.voice = selectedMandarinVoice;
      utterance.lang = selectedMandarinVoice.lang || 'zh-CN';
      utterance.rate = 0.95;

      if (trackingKey) {
        setPlayingKey(trackingKey);
        utterance.onend = () => setPlayingKey(null);
        utterance.onerror = () => setPlayingKey(null);
      }

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      if (trackingKey) setPlayingKey(null);
      setGlobalError(`Standard TTS playback error: ${err.message || 'Unable to speak text.'}`);
    }
  };

  // Add Term UI States (Stage A: Input Preview, Stage B: Card Review)
  const [showStageAAddModal, setShowStageAAddModal] = useState(false);
  const [stageANewTerm, setStageANewTerm] = useState('');
  const [stageANewSentence, setStageANewSentence] = useState('');

  const [showStageBAddModal, setShowStageBAddModal] = useState(false);
  const [stageBNewTerm, setStageBNewTerm] = useState('');
  const [stageBNewSentence, setStageBNewSentence] = useState('');
  const [isAddingStageBTerm, setIsAddingStageBTerm] = useState(false);

  const exportSectionRef = useRef(null);

  // Stage 4: Export & Deck State
  const [deckName, setDeckName] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.DECK_NAME) || 'Mandarin Core Vocabulary';
  });
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState(null); // { type: 'success'|'error', message }

  // Stage 5: Persistent Vocabulary History
  const [vocabHistory, setVocabHistory] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.HISTORY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  });
  const [historySearch, setHistorySearch] = useState('');
  const [storageAvailable, setStorageAvailable] = useState(true);

  // Preview UI Controls
  const [previewSide, setPreviewSide] = useState('both'); // 'front' | 'back' | 'both'
  const [collapsedItems, setCollapsedItems] = useState({});
  const [regeneratingCardId, setRegeneratingCardId] = useState(null);
  const [confirmRegenModal, setConfirmRegenModal] = useState(null); // { cardItem, mode: 'full' | 'alternative_sentence' }
  const [showApiHelpModal, setShowApiHelpModal] = useState(false);

  // Keep browser tab title updated
  useEffect(() => {
    document.title = 'Chinese Flashcard Generator';
  }, []);

  // Check localStorage availability & persist session state
  useEffect(() => {
    try {
      localStorage.setItem('__test_storage__', '1');
      localStorage.removeItem('__test_storage__');
      setStorageAvailable(true);
    } catch (e) {
      setStorageAvailable(false);
    }
  }, []);

  useEffect(() => {
    if (!storageAvailable) return;
    try {
      localStorage.setItem(
        STORAGE_KEYS.SESSION_DRAFT,
        JSON.stringify({ rawInput, cardsData })
      );
    } catch (e) {
      // Ignore quota exceeded if draft is huge
    }
  }, [rawInput, cardsData, storageAvailable]);

  useEffect(() => {
    if (!storageAvailable) return;
    try {
      localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(vocabHistory));
    } catch (e) {}
  }, [vocabHistory, storageAvailable]);

  useEffect(() => {
    if (!storageAvailable) return;
    try {
      localStorage.setItem(STORAGE_KEYS.DECK_NAME, deckName);
    } catch (e) {}
  }, [deckName, storageAvailable]);

  // ============================================================================
  // STAGE 1 & STAGE 2: PARSING, LLM CARD GENERATION & ADD TERM HANDLERS
  // ============================================================================

  const activeParsedEntries = useMemo(() => {
    if (!parsedState?.uniqueEntries) return [];
    return parsedState.uniqueEntries.filter((e) => !e.skipGeneration);
  }, [parsedState]);

  const handleParseInput = () => {
    setParseError('');
    setGlobalError('');
    if (!rawInput.trim()) {
      setParseError('Please paste at least one Chinese vocabulary term or parenthesized custom sentence.');
      setParsedState(null);
      return;
    }
    const result = parseMixedChineseInput(rawInput, vocabHistory);
    if (result.uniqueEntries.length === 0) {
      setParseError('No valid vocabulary entries were found.');
      setParsedState(null);
      return;
    }
    setParsedState(result);
  };

  const handleEditParsedEntry = (entryId, field, value) => {
    setParsedState((prev) => {
      if (!prev) return prev;
      const updated = prev.uniqueEntries.map((entry) => {
        if (entry.id !== entryId) return entry;
        if (field === 'chunk') {
          const nextChunk = value;
          return {
            ...entry,
            chunk: nextChunk,
            inHistory: Boolean(vocabHistory[nextChunk.trim()]),
            historyDate: vocabHistory[nextChunk.trim()]?.createdAt || null,
            issue: validateChunkFormat(nextChunk.trim())
          };
        }
        if (field === 'customSentence') {
          const trimmedSent = value;
          const hasSent = Boolean(trimmedSent.trim());
          return {
            ...entry,
            customSentences: hasSent ? [trimmedSent] : [],
            hasCustomSentence: hasSent
          };
        }
        return entry;
      });
      return { ...prev, uniqueEntries: updated };
    });
  };

  const handleToggleSkipEntry = (entryId) => {
    setParsedState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        uniqueEntries: prev.uniqueEntries.map((e) =>
          e.id === entryId ? { ...e, skipGeneration: !e.skipGeneration } : e
        )
      };
    });
  };

  const handleRemoveParsedEntry = (entryId) => {
    setParsedState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        uniqueEntries: prev.uniqueEntries.filter((e) => e.id !== entryId)
      };
    });
  };

  const handleAddTermStageA = (e) => {
    e.preventDefault();
    const cleanTerm = stageANewTerm.trim();
    if (!cleanTerm) return;

    const rawSent = stageANewSentence.trim();
    const formattedSent = rawSent
      ? ensureChineseEndingPunctuation(rawSent.replace(/[(（]([^()（）]+)[)）]/g, '$1'))
      : '';

    setParsedState((prev) => {
      const base = prev || {
        rawItems: [],
        uniqueEntries: [],
        duplicateEvents: [],
        invalidEntries: []
      };
      const existingIdx = base.uniqueEntries.findIndex((item) => item.chunk === cleanTerm);
      if (existingIdx >= 0) {
        const updatedEntries = [...base.uniqueEntries];
        const existing = updatedEntries[existingIdx];
        updatedEntries[existingIdx] = {
          ...existing,
          occurrences: existing.occurrences + 1,
          skipGeneration: false,
          customSentences: formattedSent
            ? [formattedSent, ...existing.customSentences]
            : existing.customSentences,
          hasCustomSentence: Boolean(formattedSent) || existing.hasCustomSentence
        };
        return {
          ...base,
          uniqueEntries: updatedEntries,
          duplicateEvents: [
            ...base.duplicateEvents,
            { chunk: cleanTerm, lineNum: 'Manual', sourceType: formattedSent ? 'custom_sentence' : 'vocab' }
          ]
        };
      }

      const newEntry = {
        id: `vocab-manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        chunk: cleanTerm,
        occurrences: 1,
        customSentences: formattedSent ? [formattedSent] : [],
        hasCustomSentence: Boolean(formattedSent),
        inHistory: Boolean(vocabHistory[cleanTerm]),
        historyDate: vocabHistory[cleanTerm]?.createdAt || null,
        skipGeneration: false,
        issue: validateChunkFormat(cleanTerm),
        lineNums: ['Manual']
      };

      return {
        ...base,
        uniqueEntries: [...base.uniqueEntries, newEntry]
      };
    });

    setStageANewTerm('');
    setStageANewSentence('');
    setShowStageAAddModal(false);
  };

  const callGeminiForBatch = async (entriesBatch, forceNewSentence = false) => {
    const itemsPayload = entriesBatch.map((entry) => ({
      term: entry.chunk,
      customSentence: !forceNewSentence && entry.hasCustomSentence ? entry.customSentences[0] : null
    }));

    const hskInstruction = hskLevel
      ? `   - Target HSK 3.0 difficulty level: ${hskLevel}. Use surrounding vocabulary and grammar appropriate for ${hskLevel} learners so the rest of the sentence stays within ${hskLevel}, while keeping "term" verbatim even if "term" itself is above ${hskLevel}.\n`
      : '';

    const prompt = `You are a precise Mandarin Chinese curriculum designer creating Anki flashcards for beginner-to-intermediate learners.
For each item in the JSON array below, generate linguistic data in Simplified Chinese and standard Mandarin Pinyin with tone marks.

Rules:
1. If "customSentence" is provided (not null):
   - You MUST preserve the exact Chinese sentence provided in "customSentence" (ensuring proper full-width Chinese ending punctuation 。, ？, or ！).
   - Check if the custom sentence is grammatically natural and clearly demonstrates the meaning of "term". If it is unnatural, ungrammatical, or missing the term, set "customSentenceFlagged" to true and explain briefly in "customSentenceNote". Otherwise set "customSentenceFlagged" to false and "customSentenceNote" to "".
2. If "customSentence" is null:
   - Write a short, natural, everyday conversational Mandarin sentence using "term" verbatim, ending with proper Chinese punctuation (。, ？, or ！).
${hskInstruction}   - Keep grammar simple and use varied sentence structures across items.
   - Set "customSentenceFlagged" to false and "customSentenceNote" to "".
3. "clozeHint": A short English hint explaining the missing target term in context (without giving away the Chinese characters).
4. "components": Break down each Chinese character in "term" with a short, beginner-friendly explanation of useful radicals, semantic components, or phonetic components, naturally incorporating the overall general meaning of the target character whenever it is reliably known.
   - CRITICAL: Since "char" is already shown in its own separate box, NEVER repeat the target character itself (or its pinyin/colon prefix) at the start of "explanation".
   - If the character has MULTIPLE components: Display each component character with its tone-marked Hanyu Pinyin and English meaning, starting directly with the component breakdown without repeating the target character, and naturally include the target character's overall meaning when reliable (e.g., "囗 (wéi, enclosure) radical, with 韦 (wéi, leather) as a phonetic component, meaning to surround or encircle." or "讠/言 (yán, speech) radical, with 兑 (duì, exchange/joy) as a phonetic component, meaning to speak or say something.").
   - If the character has ONLY ONE component (i.e., it is a standalone radical or single-component pictograph/character): Do NOT display the component character itself again. Instead, start directly with ONLY its tone-marked pinyin and overall English meaning in parentheses, followed by the explanation (e.g., for 开: "(kāi, open) radical representing the action of removing a bar to open a door." or for 门: "(mén, door) radical representing the shape of a swinging door or gate.").
   - When a radical/component has a variant form in a multi-component character, show the variant and its corresponding full character separated by "/", followed by the pinyin pronunciation and meaning (e.g., "氵/水 (shuǐ, water)", "亻/人 (rén, person)", "讠/言 (yán, speech)").
   - Keep existing semantic and phonetic explanations concise and accurate. Only include the overall meaning when it is reliable and useful; do not invent readings, meanings, or etymologies for characters or components without reliable pronunciations, and if uncertain, state so clearly.

Input items:
${JSON.stringify(itemsPayload, null, 2)}

Return ONLY a valid JSON array matching the exact order of input items, where every object has:
{
  "term": "string",
  "pinyin": "string",
  "definition": "string",
  "clozeHint": "string",
  "sentence": "string",
  "sentencePinyin": "string",
  "sentenceTranslation": "string",
  "customSentenceFlagged": boolean,
  "customSentenceNote": "string",
  "components": [{ "char": "string", "explanation": "string" }]
}`;

    const parsed = await geminiService.generateTextJson({
      apiKey: geminiApiKey,
      prompt
    });
    return Array.isArray(parsed) ? parsed : [];
  };

  const buildCardPairFromResult = (entry, llmItem, idxOffset = 0) => {
    const uid = `${Date.now()}_${idxOffset}_${Math.random().toString(36).slice(2, 6)}`;
    const target = String(entry.chunk || llmItem?.term || '').trim();
    const rawSent =
      entry.hasCustomSentence && entry.customSentences[0]
        ? entry.customSentences[0]
        : String(llmItem?.sentence || target);
    const sentence = ensureChineseEndingPunctuation(rawSent);
    const pinyin = String(llmItem?.pinyin || '');
    const definition = String(llmItem?.definition || '');
    const hint = String(llmItem?.clozeHint || definition);
    const sentencePinyin = String(llmItem?.sentencePinyin || '');
    const sentenceTranslation = String(llmItem?.sentenceTranslation || '');
    const rawComponents = Array.isArray(llmItem?.components) ? llmItem.components : [];
    const components =
      rawComponents.length > 0
        ? rawComponents.map((c) => {
            const ch = String(c?.char || '').trim();
            let exp = String(c?.explanation || '').trim();
            if (ch && exp) {
              const escapedCh = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              // If single-component starts with "门 (mén, door)...", strip the leading character while preserving "(mén, door)"
              const singleCompParenRegex = new RegExp(`^${escapedCh}\\s*(\\([^)]+\\))\\s*`);
              if (singleCompParenRegex.test(exp)) {
                exp = exp.replace(singleCompParenRegex, '$1 ');
              } else {
                const prefixRegex = new RegExp(`^${escapedCh}\\s*(?:\\([^)]*\\))?\\s*[:：\\-–—]?\\s*`);
                const stripped = exp.replace(prefixRegex, '');
                if (stripped) {
                  exp = stripped.charAt(0).toUpperCase() + stripped.slice(1);
                }
              }
            }
            return { char: ch, explanation: exp };
          })
        : Array.from(target).map((ch) => ({
            char: ch,
            explanation: 'Character component breakdown not available.'
          }));

    return {
      id: uid,
      chunk: target,
      wordAudioKey: `word_${uid}`,
      sentenceAudioKey: `sent_${uid}`,
      deletedCloze: false,
      deletedRecognition: false,
      hasCustomSentence: Boolean(entry.hasCustomSentence),
      customSentenceFlagged: Boolean(llmItem?.customSentenceFlagged),
      customSentenceNote: String(llmItem?.customSentenceNote || ''),
      cloze: {
        sentence,
        target,
        hint,
        pinyin,
        definition,
        sentencePinyin,
        sentenceTranslation
      },
      recognition: {
        target,
        pinyin,
        definition,
        components,
        sentence,
        sentencePinyin,
        sentenceTranslation
      },
      editedFields: {},
      warnings: { sentenceChanged: false, targetChanged: false }
    };
  };

  const handleGenerateAllCards = async () => {
    if (activeParsedEntries.length === 0 || isGenerating) return;
    setIsGenerating(true);
    setGlobalError('');

    const total = activeParsedEntries.length;
    const batchSize = 6;
    const generatedCards = [];

    try {
      for (let i = 0; i < total; i += batchSize) {
        const batch = activeParsedEntries.slice(i, i + batchSize);
        setGenerationProgress({
          current: i,
          total,
          label: `Generating definitions, components & sentences (${i + 1}–${Math.min(i + batchSize, total)} of ${total})...`
        });

        const llmResults = await callGeminiForBatch(batch, false);
        batch.forEach((entry, bIdx) => {
          const match = llmResults[bIdx] || {};
          generatedCards.push(buildCardPairFromResult(entry, match, i + bIdx));
        });
      }

      setGenerationProgress({ current: total, total, label: 'Completed!' });
      setCardsData(generatedCards);
      setActiveTab('review');
    } catch (err) {
      setGlobalError(`Flashcard generation failed: ${err.message || 'Unknown error'}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAddTermStageB = async (e) => {
    e.preventDefault();
    const cleanTerm = stageBNewTerm.trim();
    if (!cleanTerm || isAddingStageBTerm) return;

    setIsAddingStageBTerm(true);
    setGlobalError('');

    try {
      const rawSent = stageBNewSentence.trim();
      const formattedSent = rawSent
        ? ensureChineseEndingPunctuation(rawSent.replace(/[(（]([^()（）]+)[)）]/g, '$1'))
        : '';

      const entry = {
        chunk: cleanTerm,
        hasCustomSentence: Boolean(formattedSent),
        customSentences: formattedSent ? [formattedSent] : []
      };

      const llmResults = await callGeminiForBatch([entry], false);
      const newCardPair = buildCardPairFromResult(entry, llmResults[0] || {}, cardsData.length);

      setCardsData((prev) => [...prev, newCardPair]);
      setStageBNewTerm('');
      setStageBNewSentence('');
      setShowStageBAddModal(false);
    } catch (err) {
      setGlobalError(`Failed to add term "${cleanTerm}": ${err.message || 'Unknown error'}`);
    } finally {
      setIsAddingStageBTerm(false);
    }
  };

  const handleDeleteIndividualCard = (cardId, cardType) => {
    setCardsData((prev) =>
      prev
        .map((item) => {
          if (item.id !== cardId) return item;
          if (cardType === 'cloze') {
            return { ...item, deletedCloze: true };
          }
          return { ...item, deletedRecognition: true };
        })
        .filter((item) => !(item.deletedCloze && item.deletedRecognition))
    );
  };

  const handleFieldEdit = (cardId, cardSection, fieldName, newValue) => {
    setCardsData((prev) =>
      prev.map((item) => {
        if (item.id !== cardId) return item;
        const editKey = `${cardSection}.${fieldName}`;
        const updated = {
          ...item,
          [cardSection]: {
            ...item[cardSection],
            [fieldName]: newValue
          },
          editedFields: {
            ...(item.editedFields || {}),
            [editKey]: true
          },
          warnings: { ...(item.warnings || {}) }
        };

        // Keep shared fields synchronized unless the counterpart was already manually edited
        if (fieldName === 'target') {
          updated.warnings.targetChanged = true;
          const otherSection = cardSection === 'cloze' ? 'recognition' : 'cloze';
          if (!item.editedFields?.[`${otherSection}.target`]) {
            updated[otherSection] = { ...updated[otherSection], target: newValue };
          }
        }
        if (fieldName === 'sentence') {
          updated.warnings.sentenceChanged = true;
          const otherSection = cardSection === 'cloze' ? 'recognition' : 'cloze';
          if (!item.editedFields?.[`${otherSection}.sentence`]) {
            updated[otherSection] = { ...updated[otherSection], sentence: newValue };
          }
        }
        if (fieldName === 'pinyin' || fieldName === 'definition' || fieldName === 'sentencePinyin' || fieldName === 'sentenceTranslation') {
          const otherSection = cardSection === 'cloze' ? 'recognition' : 'cloze';
          if (!item.editedFields?.[`${otherSection}.${fieldName}`]) {
            updated[otherSection] = { ...updated[otherSection], [fieldName]: newValue };
          }
        }

        return updated;
      })
    );
  };

  const dismissCardWarning = (cardId, warningKey) => {
    setCardsData((prev) =>
      prev.map((item) =>
        item.id === cardId
          ? { ...item, warnings: { ...(item.warnings || {}), [warningKey]: false } }
          : item
      )
    );
  };

  const handleComponentEdit = (cardId, compIndex, key, value) => {
    setCardsData((prev) =>
      prev.map((item) => {
        if (item.id !== cardId) return item;
        const nextComponents = item.recognition.components.map((c, idx) =>
          idx === compIndex ? { ...c, [key]: value } : c
        );
        return {
          ...item,
          recognition: {
            ...item.recognition,
            components: nextComponents
          },
          editedFields: {
            ...(item.editedFields || {}),
            [`recognition.components.${compIndex}.${key}`]: true
          }
        };
      })
    );
  };

  const handleAddComponentRow = (cardId) => {
    setCardsData((prev) =>
      prev.map((item) =>
        item.id === cardId
          ? {
              ...item,
              recognition: {
                ...item.recognition,
                components: [...item.recognition.components, { char: '', explanation: '' }]
              }
            }
          : item
      )
    );
  };

  const handleRemoveComponentRow = (cardId, compIndex) => {
    setCardsData((prev) =>
      prev.map((item) =>
        item.id === cardId
          ? {
              ...item,
              recognition: {
                ...item.recognition,
                components: item.recognition.components.filter((_, idx) => idx !== compIndex)
              }
            }
          : item
      )
    );
  };

  const triggerRegenerateCard = (cardItem, mode) => {
    const hasManualEdits = Object.keys(cardItem.editedFields || {}).length > 0;
    if (hasManualEdits) {
      setConfirmRegenModal({ cardItem, mode });
    } else {
      executeRegenerateCard(cardItem, mode, true);
    }
  };

  const executeRegenerateCard = async (cardItem, mode, overwriteManualEdits) => {
    setConfirmRegenModal(null);
    setRegeneratingCardId(cardItem.id);
    setGlobalError('');

    try {
      const forceNewSentence = mode === 'alternative_sentence';
      const entry = {
        chunk: cardItem.cloze.target,
        hasCustomSentence: !forceNewSentence && cardItem.hasCustomSentence,
        customSentences: !forceNewSentence && cardItem.hasCustomSentence ? [cardItem.cloze.sentence] : []
      };

      const llmItems = await callGeminiForBatch([entry], forceNewSentence);
      const match = llmItems[0] || {};
      const nextSentence =
        !forceNewSentence && cardItem.hasCustomSentence
          ? ensureChineseEndingPunctuation(cardItem.cloze.sentence)
          : match.sentence || cardItem.cloze.sentence;

      setCardsData((prev) =>
        prev.map((item) => {
          if (item.id !== cardItem.id) return item;
          const edited = overwriteManualEdits ? {} : item.editedFields || {};
          const pick = (path, newVal, oldVal) => (!overwriteManualEdits && edited[path] ? oldVal : newVal);

          return {
            ...item,
            hasCustomSentence: forceNewSentence ? false : item.hasCustomSentence,
            customSentenceFlagged: Boolean(match.customSentenceFlagged),
            customSentenceNote: match.customSentenceNote || '',
            cloze: {
              sentence: pick('cloze.sentence', nextSentence, item.cloze.sentence),
              target: pick('cloze.target', item.cloze.target, item.cloze.target),
              hint: pick('cloze.hint', match.clozeHint || match.definition || '', item.cloze.hint),
              pinyin: pick('cloze.pinyin', match.pinyin || '', item.cloze.pinyin),
              definition: pick('cloze.definition', match.definition || '', item.cloze.definition),
              sentencePinyin: pick('cloze.sentencePinyin', match.sentencePinyin || '', item.cloze.sentencePinyin),
              sentenceTranslation: pick(
                'cloze.sentenceTranslation',
                match.sentenceTranslation || '',
                item.cloze.sentenceTranslation
              )
            },
            recognition: {
              target: pick('recognition.target', item.recognition.target, item.recognition.target),
              pinyin: pick('recognition.pinyin', match.pinyin || '', item.recognition.pinyin),
              definition: pick('recognition.definition', match.definition || '', item.recognition.definition),
              components:
                !overwriteManualEdits &&
                Object.keys(edited).some((k) => k.startsWith('recognition.components'))
                  ? item.recognition.components
                  : Array.isArray(match.components) && match.components.length > 0
                  ? match.components
                  : item.recognition.components,
              sentence: pick('recognition.sentence', nextSentence, item.recognition.sentence),
              sentencePinyin: pick(
                'recognition.sentencePinyin',
                match.sentencePinyin || '',
                item.recognition.sentencePinyin
              ),
              sentenceTranslation: pick(
                'recognition.sentenceTranslation',
                match.sentenceTranslation || '',
                item.recognition.sentenceTranslation
              )
            },
            editedFields: edited,
            warnings: { sentenceChanged: false, targetChanged: false }
          };
        })
      );
    } catch (err) {
      setGlobalError(`Regeneration error for "${cardItem.cloze.target}": ${err.message}`);
    } finally {
      setRegeneratingCardId(null);
    }
  };

  // ============================================================================
  // STAGE 3 HANDLERS: MANDARIN TTS AUDIO GENERATION & PLAYBACK
  // ============================================================================

  const isAudioUpToDate = (audioKey, currentText) => {
    const entry = audioStoreRef.current[audioKey];
    if (!entry || entry.status !== 'ready' || !entry.blob || !entry.url) return false;
    return (entry.textSnapshot || '').trim() === (currentText || '').trim();
  };

  const generateSingleAudio = async (audioKey, chineseText) => {
    const normalizedText = (chineseText || '').trim();
    if (!normalizedText) return false;

    if (audioMethod === 'standard') {
      setAudioStore((prev) => ({
        ...prev,
        [audioKey]: {
          ...prev[audioKey],
          status: 'loading',
          error: null
        }
      }));

      try {
        const preferredLang = selectedMandarinVoice?.lang || 'zh-CN';
        const { blob, ext } = await geminiService.generateStandardTtsBlob({
          text: normalizedText,
          lang: preferredLang
        });
        const audioUrl = URL.createObjectURL(blob);

        setAudioStore((prev) => {
          if (prev[audioKey]?.url) {
            URL.revokeObjectURL(prev[audioKey].url);
          }
          return {
            ...prev,
            [audioKey]: {
              url: audioUrl,
              blob,
              ext,
              sourceMethod: 'standard',
              status: 'ready',
              textSnapshot: normalizedText,
              error: null
            }
          };
        });
        return true;
      } catch (err) {
        setAudioStore((prev) => {
          const existing = prev[audioKey];
          const hasFallbackAudio = Boolean(existing?.blob && existing?.url);
          return {
            ...prev,
            [audioKey]: {
              ...existing,
              status: hasFallbackAudio ? 'ready' : 'error',
              error: err.message || 'Standard TTS file generation failed'
            }
          };
        });
        return false;
      }
    }

    if (!geminiApiKey.trim()) {
      setGlobalError(
        'A Gemini API key is required before generating AI Mandarin audio. Enter your key in the Gemini API Key bar or switch to Standard Mandarin TTS.'
      );
      return false;
    }

    setAudioStore((prev) => ({
      ...prev,
      [audioKey]: {
        ...prev[audioKey],
        // Keep existing url & blob intact until replacement succeeds
        status: 'loading',
        error: null
      }
    }));

    try {
      const { audioData, mimeType } = await geminiService.generateTtsAudio({
        apiKey: geminiApiKey,
        text: normalizedText
      });

      const rateMatch = mimeType.match(/rate=(\d+)/);
      const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
      const pcmBuffer = base64ToArrayBuffer(audioData);
      const pcm16 = new Int16Array(pcmBuffer);
      const wavBlob = pcmToWav(pcm16, sampleRate);
      const audioUrl = URL.createObjectURL(wavBlob);

      setAudioStore((prev) => {
        if (prev[audioKey]?.url) {
          URL.revokeObjectURL(prev[audioKey].url);
        }
        return {
          ...prev,
          [audioKey]: {
            url: audioUrl,
            blob: wavBlob,
            ext: 'wav',
            sourceMethod: 'ai',
            status: 'ready',
            textSnapshot: normalizedText,
            error: null
          }
        };
      });
      return true;
    } catch (err) {
      setAudioStore((prev) => {
        const existing = prev[audioKey];
        const hasFallbackAudio = Boolean(existing?.blob && existing?.url);
        return {
          ...prev,
          [audioKey]: {
            ...existing,
            // Preserve old audio if replacement failed; otherwise mark error
            status: hasFallbackAudio ? 'ready' : 'error',
            error: err.message || 'Audio generation failed'
          }
        };
      });
      return false;
    }
  };

  const handleGenerateTermAudio = async () => {
    if (cardsData.length === 0 || isGeneratingTermAudio) return;
    if (audioMethod === 'ai' && !geminiApiKey.trim()) {
      setGlobalError(
        'A Gemini API key is required before generating AI Mandarin audio. Enter your key in the Gemini API Key bar or switch to Standard Mandarin TTS.'
      );
      return;
    }
    setIsGeneratingTermAudio(true);

    const allTasks = cardsData.map((item) => ({
      key: item.wordAudioKey,
      text: ((!item.deletedCloze ? item.cloze.target : item.recognition.target) || '').trim()
    }));

    const alreadyCompletedCount = allTasks.filter((t) => isAudioUpToDate(t.key, t.text)).length;
    const pendingTasks = allTasks.filter((t) => !isAudioUpToDate(t.key, t.text));

    let completed = alreadyCompletedCount;
    setTermAudioProgress({ current: completed, total: allTasks.length });

    for (let i = 0; i < pendingTasks.length; i++) {
      const success = await generateSingleAudio(pendingTasks[i].key, pendingTasks[i].text);
      if (success) {
        completed += 1;
      }
      setTermAudioProgress({ current: completed, total: allTasks.length });
    }

    setIsGeneratingTermAudio(false);
  };

  const handleGenerateSentenceAudio = async () => {
    if (cardsData.length === 0 || isGeneratingSentenceAudio) return;
    if (audioMethod === 'ai' && !geminiApiKey.trim()) {
      setGlobalError(
        'A Gemini API key is required before generating AI Mandarin audio. Enter your key in the Gemini API Key bar or switch to Standard Mandarin TTS.'
      );
      return;
    }
    setIsGeneratingSentenceAudio(true);

    const allTasks = cardsData.map((item) => ({
      key: item.sentenceAudioKey,
      text: ((!item.deletedCloze ? item.cloze.sentence : item.recognition.sentence) || '').trim()
    }));

    const alreadyCompletedCount = allTasks.filter((t) => isAudioUpToDate(t.key, t.text)).length;
    const pendingTasks = allTasks.filter((t) => !isAudioUpToDate(t.key, t.text));

    let completed = alreadyCompletedCount;
    setSentenceAudioProgress({ current: completed, total: allTasks.length });

    for (let i = 0; i < pendingTasks.length; i++) {
      const success = await generateSingleAudio(pendingTasks[i].key, pendingTasks[i].text);
      if (success) {
        completed += 1;
      }
      setSentenceAudioProgress({ current: completed, total: allTasks.length });
    }

    setIsGeneratingSentenceAudio(false);
  };

  const handlePlayAudio = (audioKey, fallbackText) => {
    if (audioMethod === 'standard') {
      speakWithDeviceTts(fallbackText, audioKey);
      return;
    }

    const entry = audioStore[audioKey];
    if (!entry || entry.status !== 'ready' || !entry.url) {
      // Generate on demand if not yet generated
      generateSingleAudio(audioKey, fallbackText);
      return;
    }

    if (activeAudioRef.current) {
      activeAudioRef.current.pause();
      activeAudioRef.current = null;
    }

    if (playingKey === audioKey) {
      setPlayingKey(null);
      return;
    }

    const audio = new Audio(entry.url);
    activeAudioRef.current = audio;
    setPlayingKey(audioKey);
    audio.onended = () => setPlayingKey(null);
    audio.onerror = () => setPlayingKey(null);
    audio.play().catch(() => setPlayingKey(null));
  };

  // ============================================================================
  // STAGE 4 & 5: QUALITY VALIDATION, HISTORY RECORDING, AND .APKG EXPORT
  // ============================================================================

  const qualityReport = useMemo(() => {
    const issues = [];
    let readyTermAudioCount = 0;
    let readySentenceAudioCount = 0;
    let totalClozeCards = 0;
    let totalRecognitionCards = 0;

    cardsData.forEach((item) => {
      const hasCloze = !item.deletedCloze;
      const hasRecog = !item.deletedRecognition;
      if (hasCloze) totalClozeCards++;
      if (hasRecog) totalRecognitionCards++;

      const activeTarget = hasCloze ? item.cloze.target : item.recognition.target;
      const activeSentence = hasCloze ? item.cloze.sentence : item.recognition.sentence;

      if ((hasCloze && !item.cloze.target) || (hasRecog && !item.recognition.target)) {
        issues.push(`Missing target vocabulary chunk on card "${item.chunk}".`);
      }
      if (hasCloze && (!item.cloze.sentence || !item.cloze.sentence.includes(item.cloze.target))) {
        issues.push(`"${item.cloze.target}": Cloze target does not appear verbatim inside its sentence ("${item.cloze.sentence}").`);
      }
      if ((hasCloze && !item.cloze.pinyin) || (hasRecog && !item.recognition.pinyin)) {
        issues.push(`"${activeTarget}": Missing pinyin.`);
      }
      if ((hasCloze && !item.cloze.definition) || (hasRecog && !item.recognition.definition)) {
        issues.push(`"${activeTarget}": Missing English definition.`);
      }
      if (item.customSentenceFlagged) {
        issues.push(`"${activeTarget}": Flagged custom sentence requires review (${item.customSentenceNote}).`);
      }
      if (item.warnings?.sentenceChanged || item.warnings?.targetChanged) {
        issues.push(`"${activeTarget}": Recently edited text has unreviewed pinyin/translation warnings.`);
      }

      const termAudioEntry = audioStore[item.wordAudioKey];
      if (termAudioEntry?.status === 'ready' && termAudioEntry?.blob) {
        readyTermAudioCount++;
        if ((termAudioEntry.textSnapshot || '').trim() !== (activeTarget || '').trim()) {
          issues.push(`"${activeTarget}": Term Audio needs regeneration because the term text changed.`);
        }
      }

      const sentAudioEntry = audioStore[item.sentenceAudioKey];
      if (sentAudioEntry?.status === 'ready' && sentAudioEntry?.blob) {
        readySentenceAudioCount++;
        if ((sentAudioEntry.textSnapshot || '').trim() !== (activeSentence || '').trim()) {
          issues.push(`"${activeTarget}": Sentence Audio needs regeneration because the sentence text changed.`);
        }
      }
    });

    return {
      totalChunks: cardsData.length,
      totalClozeCards,
      totalRecognitionCards,
      totalCards: totalClozeCards + totalRecognitionCards,
      issues,
      readyTermAudioCount,
      readySentenceAudioCount,
      readyAudioCount: readyTermAudioCount + readySentenceAudioCount,
      expectedAudioCount: cardsData.length * 2
    };
  }, [cardsData, audioStore]);

  const handleExportApkg = async () => {
    if (cardsData.length === 0 || qualityReport.totalCards === 0) return;
    setIsExporting(true);
    setExportStatus(null);

    try {
      const apkgBlob = await buildGenuineApkg(cardsData, deckName, audioStore);
      const safeFileName = (deckName.trim() || 'Chinese_Vocabulary')
        .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff ]/g, '')
        .replace(/\s+/g, '_');

      const downloadUrl = URL.createObjectURL(apkgBlob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `${safeFileName}.apkg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);

      // Save exported chunks to persistent vocabulary history
      const nowIso = new Date().toISOString();
      setVocabHistory((prev) => {
        const updated = { ...prev };
        cardsData.forEach((item) => {
          const hasCloze = !item.deletedCloze;
          const targetTerm = hasCloze ? item.cloze.target : item.recognition.target;
          updated[targetTerm] = {
            chunk: targetTerm,
            pinyin: hasCloze ? item.cloze.pinyin : item.recognition.pinyin,
            definition: hasCloze ? item.cloze.definition : item.recognition.definition,
            sentence: hasCloze ? item.cloze.sentence : item.recognition.sentence,
            createdAt: nowIso,
            deckName
          };
        });
        return updated;
      });

      setExportStatus({
        type: 'success',
        message: `Exported card deck "${safeFileName}.apkg" with ${qualityReport.totalCards} cards (${qualityReport.totalClozeCards} Cloze + ${qualityReport.totalRecognitionCards} Word Recognition) and ${qualityReport.readyAudioCount} embedded audio files.`
      });
    } catch (err) {
      setExportStatus({
        type: 'error',
        message: `Genuine .apkg generation encountered an error (${err.message}). You can download the CSV fallback below if needed.`
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportCsvFallback = () => {
    const rows = [
      ['CardType', 'Front', 'BackPinyin', 'Definition', 'FullSentence', 'SentencePinyin', 'Translation', 'Components']
    ];
    cardsData.forEach((item) => {
      if (!item.deletedCloze) {
        const clozeFormatted = buildAnkiClozeField(item.cloze.sentence, item.cloze.target);
        rows.push([
          'Sentence Cloze',
          `${clozeFormatted} (Hint: ${item.cloze.hint})`,
          item.cloze.pinyin,
          item.cloze.definition,
          item.cloze.sentence,
          item.cloze.sentencePinyin,
          item.cloze.sentenceTranslation,
          ''
        ]);
      }
      if (!item.deletedRecognition) {
        const comps = item.recognition.components.map((c) => `${c.char}: ${c.explanation}`).join(' | ');
        rows.push([
          'Word Recognition',
          item.recognition.target,
          item.recognition.pinyin,
          item.recognition.definition,
          item.recognition.sentence,
          item.recognition.sentencePinyin,
          item.recognition.sentenceTranslation,
          comps
        ]);
      }
    });
    const csvContent = rows
      .map((r) => r.map((cell) => `"${String(cell || '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${deckName.trim().replace(/\s+/g, '_') || 'Chinese_Vocab'}_fallback.csv`;
    a.click();
  };

  // History JSON Export / Import (in case browser storage is cleared or restricted)
  const handleExportHistoryJson = () => {
    const blob = new Blob([JSON.stringify(vocabHistory, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chinese_vocab_history_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };

  const handleImportHistoryJson = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (typeof imported === 'object' && imported !== null) {
          setVocabHistory((prev) => ({ ...prev, ...imported }));
        }
      } catch (err) {
        setGlobalError('Invalid history JSON file.');
      }
    };
    reader.readAsText(file);
  };

  const filteredHistoryList = useMemo(() => {
    const list = Object.values(vocabHistory).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    if (!historySearch.trim()) return list;
    const q = historySearch.toLowerCase();
    return list.filter(
      (item) =>
        item.chunk.includes(q) ||
        (item.pinyin && item.pinyin.toLowerCase().includes(q)) ||
        (item.definition && item.definition.toLowerCase().includes(q))
    );
  }, [vocabHistory, historySearch]);

  // ============================================================================
  // RENDER HELPERS
  // ============================================================================

  const renderAudioControl = (audioKey, label, chineseText) => {
    const info = audioStore[audioKey];
    const isLoading = info?.status === 'loading';
    const isReady = info?.status === 'ready' && Boolean(info?.blob);
    const isStale = isReady && (info?.textSnapshot || '').trim() !== (chineseText || '').trim();
    const isError = info?.status === 'error';
    const isPlaying = playingKey === audioKey;

    return (
      <div
        className={`inline-flex items-center gap-1.5 border rounded-lg px-2.5 py-1 text-xs ${
          isStale
            ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700'
            : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700'
        }`}
      >
        <button
          type="button"
          onClick={() => handlePlayAudio(audioKey, chineseText)}
          disabled={isLoading || !chineseText}
          className={`inline-flex items-center gap-1 font-medium transition ${
            isReady
              ? 'text-sky-700 dark:text-sky-300 hover:text-sky-800'
              : 'text-slate-600 dark:text-slate-300 hover:text-sky-600'
          } disabled:opacity-50`}
          title={
            isStale
              ? 'Text changed since audio was generated — click regenerate icon to update'
              : isReady
              ? 'Play Mandarin Audio'
              : 'Generate & Play Mandarin Audio'
          }
        >
          {isLoading ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-600" />
          ) : isPlaying ? (
            <Pause className="w-3.5 h-3.5 text-emerald-600" />
          ) : (
            <Volume2
              className={`w-3.5 h-3.5 ${
                isStale ? 'text-amber-600' : isReady ? 'text-emerald-600' : 'text-slate-500'
              }`}
            />
          )}
          <span>{label}</span>
          <span
            className={`text-[10px] uppercase tracking-wider px-1 rounded bg-white dark:bg-slate-900 ${
              isStale ? 'text-amber-700 dark:text-amber-400 font-semibold' : 'text-slate-500'
            }`}
          >
            {isLoading
              ? 'Gen...'
              : isStale
              ? 'Needs Regen'
              : isReady
              ? `${(info?.ext || 'wav').toUpperCase()} Ready`
              : isError
              ? 'Retry'
              : audioMethod === 'standard'
              ? 'Speak / File'
              : 'Generate'}
          </span>
        </button>

        <button
          type="button"
          onClick={() => generateSingleAudio(audioKey, chineseText)}
          disabled={isLoading || !chineseText}
          className="p-1 text-slate-400 hover:text-sky-600 rounded transition disabled:opacity-40"
          title="Regenerate Audio Independently"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Top Application Header */}
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-600 text-white flex items-center justify-center font-bold text-xl shadow-sm">
              汉
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                Chinese Flashcard Generator
              </h1>
            </div>
          </div>

          {/* Workflow Navigation Tabs */}
          <nav className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
            <button
              type="button"
              onClick={() => setActiveTab('input')}
              className={`px-3.5 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 ${
                activeTab === 'input'
                  ? 'bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-400 shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900'
              }`}
            >
              <Edit3 className="w-4 h-4" />
              <span>1. Input & Parse</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('review')}
              className={`px-3.5 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 ${
                activeTab === 'review'
                  ? 'bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-400 shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900'
              }`}
            >
              <Layers className="w-4 h-4" />
              <span>2. Edit Cards & Export</span>
              {cardsData.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-sky-100 dark:bg-sky-900/60 text-sky-700 dark:text-sky-300 font-semibold">
                  {qualityReport.totalCards}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`px-3.5 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 ${
                activeTab === 'history'
                  ? 'bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-400 shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900'
              }`}
            >
              <History className="w-4 h-4" />
              <span>History ({Object.keys(vocabHistory).length})</span>
            </button>

            <button
              type="button"
              onClick={() => setShowApiHelpModal(true)}
              className="p-2 text-slate-500 hover:text-sky-600 rounded-lg transition"
              title="Setup & Configuration Guide"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
          </nav>
        </div>

        {/* Session-Only Gemini API Key Bar */}
        <div className="bg-slate-50 dark:bg-slate-950/70 border-t border-slate-200 dark:border-slate-800">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex items-center gap-2 flex-1 min-w-[260px]">
              <Key className="w-3.5 h-3.5 text-sky-600 shrink-0" />
              <label
                htmlFor="session-gemini-api-key"
                className="font-semibold text-slate-700 dark:text-slate-300 shrink-0"
              >
                Gemini API Key:
              </label>
              <div className="relative flex-1 max-w-sm">
                <input
                  id="session-gemini-api-key"
                  type={showApiKey ? 'text' : 'password'}
                  value={geminiApiKey}
                  onChange={(e) => {
                    setGeminiApiKey(e.target.value);
                    if (globalError && globalError.includes('Gemini API key')) {
                      setGlobalError('');
                    }
                  }}
                  placeholder="Paste your Gemini API key (AIza...)"
                  autoComplete="off"
                  spellCheck="false"
                  className="w-full pl-2.5 pr-8 py-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-sky-500 outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((prev) => !prev)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  title={showApiKey ? 'Hide API key' : 'Show API key'}
                >
                  {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              {geminiApiKey && (
                <button
                  type="button"
                  onClick={() => setGeminiApiKey('')}
                  className="px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-200/60 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition shrink-0"
                >
                  Clear Key
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {geminiApiKey.trim() ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Session key active</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Required for card &amp; audio generation</span>
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Global Error Banner */}
      {globalError && (
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-4">
          <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-xl p-4 flex items-start justify-between gap-3 text-red-800 dark:text-red-200 text-sm">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>{globalError}</div>
            </div>
            <button onClick={() => setGlobalError('')} className="text-xs underline shrink-0">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6">
        {/* ====================================================================
            STAGE 1: MIXED INPUT & PARSED PREVIEW
           ==================================================================== */}
        {activeTab === 'input' && (
          <div className="space-y-6">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                    Paste Vocabulary & Sentences
                  </h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Separate entries with newlines or spaces. Wrap target terms in <code>( )</code> to provide a custom sentence.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setRawInput(DEFAULT_SAMPLE_TEXT);
                      setParsedState(null);
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition"
                  >
                    Load Example Input
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRawInput('');
                      setParsedState(null);
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <textarea
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
                rows={8}
                placeholder={`Paste Chinese vocabulary and custom sentences here...\nExample:\n时间\n所以\n我喜欢（吃饭）。\n包子`}
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-4 text-lg leading-relaxed font-medium text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none transition"
              />

              {parseError && (
                <div className="mt-3 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  <span>{parseError}</span>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
                <div className="text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
                  <div>• Generates <strong>2 cards per term</strong>: (1) Sentence Cloze Card + (2) Word Recognition Card</div>
                </div>

                <button
                  type="button"
                  onClick={handleParseInput}
                  className="px-6 py-3 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-semibold shadow-sm transition flex items-center gap-2"
                >
                  <FileCheck className="w-5 h-5" />
                  <span>Parse Vocabulary & Sentences</span>
                </button>
              </div>
            </div>

            {/* Parsed Input Preview & Pre-Generation Editor */}
            {parsedState && (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 shadow-sm space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                      Input Preview
                    </h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      Review, edit, or delete entries before generating cards.
                    </p>
                  </div>

                  {/* Summary Metrics */}
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setShowStageAAddModal(true)}
                      className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold shadow-sm transition flex items-center gap-1.5"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Add Term</span>
                    </button>

                    <div className="px-3.5 py-2 rounded-xl bg-sky-50 dark:bg-sky-950/60 border border-sky-200 dark:border-sky-800 text-center">
                      <div className="text-xs text-sky-700 dark:text-sky-300 font-medium">Terms</div>
                      <div className="text-xl font-bold text-sky-900 dark:text-white">{activeParsedEntries.length}</div>
                    </div>
                    <div className="px-3.5 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-center">
                      <div className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">Total Cards (2×)</div>
                      <div className="text-xl font-bold text-emerald-900 dark:text-white">{activeParsedEntries.length * 2}</div>
                    </div>
                    <div className="px-3.5 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 text-center">
                      <div className="text-xs text-indigo-700 dark:text-indigo-300 font-medium">Custom Sentences</div>
                      <div className="text-xl font-bold text-indigo-900 dark:text-white">
                        {activeParsedEntries.filter((e) => e.hasCustomSentence).length}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Duplicate & Invalid Entry Warnings */}
                {parsedState.duplicateEvents.length > 0 && (
                  <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-sm text-amber-900 dark:text-amber-200">
                    <div className="font-semibold flex items-center gap-2 mb-1">
                      <AlertTriangle className="w-4 h-4 text-amber-600" />
                      <span>Duplicate Chunks Detected in Current Batch ({parsedState.duplicateEvents.length})</span>
                    </div>
                    <p className="text-xs text-amber-800 dark:text-amber-300">
                      Duplicates were consolidated so each unique chunk generates exactly 2 cards:{' '}
                      {parsedState.duplicateEvents.map((d, i) => (
                        <span key={i} className="inline-block mr-2 font-mono bg-amber-100 dark:bg-amber-900/60 px-1.5 py-0.5 rounded">
                          {d.chunk} (line {d.lineNum})
                        </span>
                      ))}
                    </p>
                  </div>
                )}

                {parsedState.invalidEntries.length > 0 && (
                  <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-sm text-red-900 dark:text-red-200">
                    <div className="font-semibold flex items-center gap-2 mb-1">
                      <ShieldAlert className="w-4 h-4 text-red-600" />
                      <span>Entries Requiring Attention ({parsedState.invalidEntries.length})</span>
                    </div>
                    <ul className="list-disc list-inside text-xs space-y-1">
                      {parsedState.invalidEntries.map((inv, idx) => (
                        <li key={idx}>
                          Line {inv.lineNum}: <strong>{inv.chunk || inv.rawSentence}</strong> — {inv.issue}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Parsed Table */}
                <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-xs uppercase text-slate-500 dark:text-slate-400">
                        <th className="py-3 px-4">#</th>
                        <th className="py-3 px-4">Term</th>
                        <th className="py-3 px-4">Custom Sentence (Optional)</th>
                        <th className="py-3 px-4">Status & Warnings</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                      {parsedState.uniqueEntries.map((entry, idx) => (
                        <tr
                          key={entry.id}
                          className={`transition ${
                            entry.skipGeneration ? 'opacity-45 bg-slate-50 dark:bg-slate-900/40' : ''
                          }`}
                        >
                          <td className="py-3 px-4 text-slate-400 font-mono text-xs">{idx + 1}</td>
                          <td className="py-3 px-4">
                            <input
                              type="text"
                              value={entry.chunk}
                              onChange={(e) => handleEditParsedEntry(entry.id, 'chunk', e.target.value)}
                              className="w-36 sm:w-44 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-base font-bold text-slate-900 dark:text-white focus:ring-2 focus:ring-sky-500 outline-none"
                            />
                          </td>
                          <td className="py-3 px-4">
                            <input
                              type="text"
                              value={entry.customSentences[0] || ''}
                              onChange={(e) => handleEditParsedEntry(entry.id, 'customSentence', e.target.value)}
                              placeholder="Generate sentence"
                              className="w-full min-w-[220px] px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-sky-500 outline-none"
                            />
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex flex-wrap gap-1.5">
                              {entry.hasCustomSentence ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-200">
                                  <CheckCircle2 className="w-3 h-3" /> Custom Sentence
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                                  Auto Sentence
                                </span>
                              )}

                              {entry.occurrences > 1 && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200">
                                  Merged ×{entry.occurrences}
                                </span>
                              )}

                              {entry.inHistory && (
                                <span
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-200"
                                  title={`Previously generated on ${new Date(entry.historyDate).toLocaleDateString()}`}
                                >
                                  <History className="w-3 h-3" /> In History
                                </span>
                              )}

                              {entry.issue && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200">
                                  <AlertTriangle className="w-3 h-3" /> {entry.issue}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleToggleSkipEntry(entry.id)}
                              className="px-2.5 py-1 mr-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                            >
                              {entry.skipGeneration ? 'Include' : 'Skip'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveParsedEntry(entry.id)}
                              className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg transition"
                              title="Remove entry"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Generate Action Bar */}
                <div className="pt-2 flex flex-wrap items-center justify-between gap-4">
                  <div className="text-sm text-slate-600 dark:text-slate-400">
                    Ready to generate <strong>{activeParsedEntries.length * 2} flashcards</strong> for{' '}
                    <strong>{activeParsedEntries.length} new terms</strong>.
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor="hsk-level-select"
                        className="text-sm font-medium text-slate-700 dark:text-slate-300"
                      >
                        HSK:
                      </label>
                      <select
                        id="hsk-level-select"
                        value={hskLevel}
                        onChange={(e) => setHskLevel(e.target.value)}
                        className="px-3 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-medium text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-sky-500 outline-none transition"
                      >
                        <option value="">No HSK level</option>
                        <option value="HSK 1">HSK 1</option>
                        <option value="HSK 2">HSK 2</option>
                        <option value="HSK 3">HSK 3</option>
                        <option value="HSK 4">HSK 4</option>
                        <option value="HSK 5">HSK 5</option>
                        <option value="HSK 6">HSK 6</option>
                        <option value="HSK 7">HSK 7</option>
                        <option value="HSK 8">HSK 8</option>
                        <option value="HSK 9">HSK 9</option>
                      </select>
                    </div>

                    <button
                      type="button"
                      onClick={handleGenerateAllCards}
                      disabled={isGenerating || activeParsedEntries.length === 0}
                      className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold shadow-sm transition flex items-center gap-2"
                    >
                      {isGenerating ? (
                        <>
                          <RefreshCw className="w-5 h-5 animate-spin" />
                          <span>
                            Generating ({generationProgress.current}/{generationProgress.total})...
                          </span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-5 h-5" />
                          <span>Generate {activeParsedEntries.length * 2} Flashcards</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {isGenerating && (
                  <div className="bg-slate-50 dark:bg-slate-800/60 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                    <div className="flex justify-between text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">
                      <span>{generationProgress.label}</span>
                      <span>
                        {Math.round((generationProgress.current / Math.max(1, generationProgress.total)) * 100)}%
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-600 transition-all duration-300"
                        style={{
                          width: `${(generationProgress.current / Math.max(1, generationProgress.total)) * 100}%`
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ====================================================================
            STAGE 2, 3, 4: EDITABLE CARD PREVIEW, AUDIO & ANKI .APKG EXPORT
           ==================================================================== */}
        {activeTab === 'review' && (
          <div className="space-y-6">
            {cardsData.length === 0 ? (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-12 text-center">
                <BookOpen className="w-12 h-12 text-slate-300 dark:text-slate-700 mx-auto mb-3" />
                <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-1">
                  No Flashcards Generated Yet
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">
                  Start by pasting your Chinese vocabulary and custom sentences in Step 1.
                </p>
                <button
                  type="button"
                  onClick={() => setActiveTab('input')}
                  className="px-5 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-medium text-sm"
                >
                  Go to Input & Parse
                </button>
              </div>
            ) : (
              <>
                {/* Top Control Bar: Audio Batch Generation, View Mode, Quality Check & Export */}
                <div
                  ref={exportSectionRef}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-sm space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                        Review & Edit Generated Flashcards ({cardsData.length} Terms • {qualityReport.totalCards} Cards)
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Click any field below to edit directly. Manual edits are highlighted and protected.
                      </p>
                    </div>

                    {/* Preview Side Switcher & Split Audio Generation Controls */}
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        onClick={() => setShowStageBAddModal(true)}
                        className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold shadow-sm transition flex items-center gap-1.5"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Add Term</span>
                      </button>

                      <div className="inline-flex rounded-xl bg-slate-100 dark:bg-slate-800 p-1 text-xs font-medium">
                        <button
                          type="button"
                          onClick={() => setPreviewSide('both')}
                          className={`px-3 py-1.5 rounded-lg transition ${
                            previewSide === 'both'
                              ? 'bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-400 shadow-sm'
                              : 'text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          Front + Back
                        </button>
                        <button
                          type="button"
                          onClick={() => setPreviewSide('front')}
                          className={`px-3 py-1.5 rounded-lg transition ${
                            previewSide === 'front'
                              ? 'bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-400 shadow-sm'
                              : 'text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          Fronts Only
                        </button>
                        <button
                          type="button"
                          onClick={() => setPreviewSide('back')}
                          className={`px-3 py-1.5 rounded-lg transition ${
                            previewSide === 'back'
                              ? 'bg-white dark:bg-slate-900 text-sky-700 dark:text-sky-400 shadow-sm'
                              : 'text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          Backs Only
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={handleGenerateTermAudio}
                        disabled={isGeneratingTermAudio}
                        className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold shadow-sm transition flex items-center gap-1.5"
                      >
                        {isGeneratingTermAudio ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>
                              Term Audio ({termAudioProgress.current}/{termAudioProgress.total})
                            </span>
                          </>
                        ) : (
                          <>
                            <Volume2 className="w-3.5 h-3.5" />
                            <span>
                              Generate Term Audio ({qualityReport.readyTermAudioCount}/{qualityReport.totalChunks})
                            </span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={handleGenerateSentenceAudio}
                        disabled={isGeneratingSentenceAudio}
                        className="px-3.5 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-xs font-semibold shadow-sm transition flex items-center gap-1.5"
                      >
                        {isGeneratingSentenceAudio ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>
                              Sentence Audio ({sentenceAudioProgress.current}/{sentenceAudioProgress.total})
                            </span>
                          </>
                        ) : (
                          <>
                            <Volume2 className="w-3.5 h-3.5" />
                            <span>
                              Generate Sentence Audio ({qualityReport.readySentenceAudioCount}/{qualityReport.totalChunks})
                            </span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Audio Method Selector & Device Mandarin Voice Controls */}
                  <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <label
                        htmlFor="audio-method-select"
                        className="font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5"
                      >
                        <Volume2 className="w-3.5 h-3.5 text-sky-600" />
                        <span>Audio Method:</span>
                      </label>
                      <select
                        id="audio-method-select"
                        value={audioMethod}
                        onChange={(e) => setAudioMethod(e.target.value)}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 font-medium text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-sky-500 outline-none"
                      >
                        <option value="ai">AI-generated Mandarin voice</option>
                        <option value="standard">Standard Mandarin TTS</option>
                      </select>

                      {audioMethod === 'standard' && (
                        <>
                          {mandarinVoices.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-2">
                              {mandarinVoices.length > 1 ? (
                                <select
                                  aria-label="Select Mandarin Device Voice"
                                  value={selectedVoiceURI}
                                  onChange={(e) => setSelectedVoiceURI(e.target.value)}
                                  className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 focus:ring-2 focus:ring-sky-500 outline-none max-w-xs"
                                >
                                  {mandarinVoices.map((v) => (
                                    <option key={v.voiceURI} value={v.voiceURI}>
                                      {v.name} ({v.lang})
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium">
                                  Voice: {selectedMandarinVoice.name} ({selectedMandarinVoice.lang})
                                </span>
                              )}

                              <button
                                type="button"
                                onClick={() => speakWithDeviceTts('你好，欢迎学习中文。')}
                                className="px-2.5 py-1.5 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/50 hover:bg-sky-100 text-sky-700 dark:text-sky-300 font-medium transition inline-flex items-center gap-1"
                              >
                                <Play className="w-3 h-3" />
                                <span>Preview Voice</span>
                              </button>
                            </div>
                          ) : (
                            voicesLoaded && (
                              <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400 font-medium">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <span>
                                  Mandarin TTS is unavailable on this device (no zh-CN or zh-TW voice detected).
                                </span>
                              </span>
                            )
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Quality Control & Export Bar */}
                  <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-end justify-between gap-4">
                    <div className="flex-1 min-w-[240px] max-w-md">
                      <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                        Anki Deck Name
                      </label>
                      <input
                        type="text"
                        value={deckName}
                        onChange={(e) => setDeckName(e.target.value)}
                        placeholder="Mandarin Core Vocabulary"
                        className="w-full px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm font-medium text-slate-900 dark:text-white focus:ring-2 focus:ring-sky-500 outline-none"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={handleExportApkg}
                        disabled={isExporting || cardsData.length === 0}
                        className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-sm shadow-sm transition flex items-center gap-2"
                      >
                        {isExporting ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            <span>Building .apkg Package...</span>
                          </>
                        ) : (
                          <>
                            <Download className="w-4 h-4" />
                            <span>Export Card Deck (.apkg)</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={handleExportCsvFallback}
                        className="px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-600 dark:text-slate-300 transition"
                        title="Download plain CSV backup (no audio embedding)"
                      >
                        CSV Fallback
                      </button>
                    </div>
                  </div>

                  {/* Quality Check Summary */}
                  {qualityReport.issues.length > 0 ? (
                    <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200">
                      <div className="font-semibold flex items-center gap-1.5 mb-1">
                        <AlertTriangle className="w-4 h-4 text-amber-600" />
                        <span>Quality Control Notices ({qualityReport.issues.length}):</span>
                      </div>
                      <ul className="list-disc list-inside space-y-0.5">
                        {qualityReport.issues.map((iss, i) => (
                          <li key={i}>{iss}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>
                        Quality check passed: All {qualityReport.totalChunks} vocabulary chunks have 2 verified cards each. ({qualityReport.readyAudioCount}/{qualityReport.expectedAudioCount} audio files generated so far.)
                      </span>
                    </div>
                  )}

                  {exportStatus && (
                    <div
                      className={`p-3.5 rounded-xl text-sm flex items-start gap-2.5 ${
                        exportStatus.type === 'success'
                          ? 'bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
                          : 'bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
                      }`}
                    >
                      {exportStatus.type === 'success' ? (
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                      ) : (
                        <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                      )}
                      <div>{exportStatus.message}</div>
                    </div>
                  )}
                </div>

                {/* Quick Jump Navigation Bar */}
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider shrink-0">
                    Jump to chunk:
                  </span>
                  {cardsData.map((item, idx) => (
                    <a
                      key={item.id}
                      href={`#chunk-group-${item.id}`}
                      className="px-3 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-sky-500 text-sm font-medium shrink-0 transition flex items-center gap-1.5"
                    >
                      <span className="text-xs text-slate-400">{idx + 1}.</span>
                      <span>{item.cloze.target}</span>
                      {Object.keys(item.editedFields || {}).length > 0 && (
                        <span className="w-2 h-2 rounded-full bg-amber-500" title="Manually edited" />
                      )}
                    </a>
                  ))}
                </div>

                {/* Cards List Organized by Vocabulary Chunk */}
                <div className="space-y-6">
                  {cardsData.map((item, index) => {
                    const isCollapsed = Boolean(collapsedItems[item.id]);
                    const editCount = Object.keys(item.editedFields || {}).length;
                    const isRegenerating = regeneratingCardId === item.id;

                    const isEdited = (path) => Boolean(item.editedFields?.[path]);
                    const inputHighlightClass = (path) =>
                      isEdited(path)
                        ? 'border-amber-400 dark:border-amber-500 bg-amber-50/40 dark:bg-amber-950/20'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950';

                    return (
                      <section
                        id={`chunk-group-${item.id}`}
                        key={item.id}
                        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm overflow-hidden"
                      >
                        {/* Chunk Group Header */}
                        <div className="px-5 py-3.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <span className="w-7 h-7 rounded-lg bg-sky-600 text-white text-xs font-bold flex items-center justify-center">
                              {index + 1}
                            </span>
                            <span className="text-xl font-bold text-slate-900 dark:text-white">
                              {item.cloze.target}
                            </span>
                            <span className="text-sm font-medium text-sky-600 dark:text-sky-400">
                              {item.recognition.pinyin}
                            </span>

                            {item.hasCustomSentence && (
                              <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-200">
                                Custom Sentence
                              </span>
                            )}

                            {editCount > 0 && (
                              <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200">
                                {editCount} Manual Edit{editCount > 1 ? 's' : ''}
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            {item.hasCustomSentence && (
                              <button
                                type="button"
                                onClick={() => triggerRegenerateCard(item, 'alternative_sentence')}
                                disabled={isRegenerating}
                                className="px-3 py-1.5 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-950/40 hover:bg-indigo-100 text-xs font-medium text-indigo-700 dark:text-indigo-300 transition"
                              >
                                Request Alternative Sentence
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => triggerRegenerateCard(item, 'full')}
                              disabled={isRegenerating}
                              className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 transition flex items-center gap-1.5"
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
                              <span>{isRegenerating ? 'Regenerating...' : 'Regenerate Pair'}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() =>
                                setCollapsedItems((prev) => ({ ...prev, [item.id]: !prev[item.id] }))
                              }
                              className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                              title={isCollapsed ? 'Expand Cards' : 'Collapse Cards'}
                            >
                              {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                            </button>
                          </div>
                        </div>

                        {/* Flagged Custom Sentence Warning */}
                        {item.customSentenceFlagged && (
                          <div className="px-5 py-3 bg-amber-50 dark:bg-amber-950/50 border-b border-amber-200 dark:border-amber-800 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900 dark:text-amber-200">
                            <div className="flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                              <div>
                                <strong>Custom Sentence Review Notice:</strong> {item.customSentenceNote}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => triggerRegenerateCard(item, 'alternative_sentence')}
                              className="px-2.5 py-1 rounded bg-amber-600 text-white font-medium hover:bg-amber-700 shrink-0"
                            >
                              Generate AI Alternative
                            </button>
                          </div>
                        )}

                        {/* Edit Dependency Warnings */}
                        {(item.warnings?.sentenceChanged || item.warnings?.targetChanged) && (
                          <div className="px-5 py-2.5 bg-sky-50 dark:bg-sky-950/40 border-b border-sky-200 dark:border-sky-800 flex flex-wrap items-center justify-between gap-2 text-xs text-sky-900 dark:text-sky-200">
                            <div className="flex items-center gap-2">
                              <Info className="w-4 h-4 text-sky-600 shrink-0" />
                              <span>
                                {item.warnings.targetChanged &&
                                  'Vocabulary chunk was edited — please review its pinyin, definition, and cloze sentence. '}
                                {item.warnings.sentenceChanged &&
                                  'Sentence was edited — please verify that sentence pinyin, English translation, and sentence audio match.'}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                dismissCardWarning(item.id, 'sentenceChanged');
                                dismissCardWarning(item.id, 'targetChanged');
                              }}
                              className="underline font-medium shrink-0"
                            >
                              Mark Reviewed
                            </button>
                          </div>
                        )}

                        {/* Two Cards Grid: Card 1 (Sentence Cloze) & Card 2 (Word Recognition) */}
                        {!isCollapsed && (
                          <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
                            {/* ========================================================
                                CARD TYPE 1: SENTENCE CLOZE CARD
                               ======================================================== */}
                            {!item.deletedCloze && (
                            <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col bg-slate-50/40 dark:bg-slate-950/40">
                              <div className="px-4 py-2.5 bg-sky-50/80 dark:bg-sky-950/40 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                                <span className="text-xs font-bold uppercase tracking-wider text-sky-800 dark:text-sky-300">
                                  Card 1: Sentence Cloze Card
                                </span>
                                <div className="flex items-center gap-2">
                                  <span className="text-[11px] text-slate-500">Contextual Cloze</span>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteIndividualCard(item.id, 'cloze')}
                                    className="p-1 text-slate-400 hover:text-red-600 rounded transition"
                                    title="Delete Sentence Cloze Card"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>

                              {/* Anki Card Front Preview (Highlights Target Term — No Underscores) */}
                              {(previewSide === 'both' || previewSide === 'front') && (
                                <div className="p-4 border-b border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
                                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                                    Front Preview
                                  </div>
                                  <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-center space-y-2.5">
                                    <div className="text-xl sm:text-2xl font-semibold text-slate-900 dark:text-white leading-relaxed">
                                      {item.cloze.target && item.cloze.sentence.includes(item.cloze.target) ? (
                                        item.cloze.sentence.split(item.cloze.target).map((part, pIdx, arr) => (
                                          <React.Fragment key={pIdx}>
                                            {part}
                                            {pIdx < arr.length - 1 && (
                                              <span
                                                className="inline-block mx-0.5 px-2 py-0.5 rounded-md bg-sky-100 dark:bg-sky-900/60 text-sky-800 dark:text-sky-200 ring-1 ring-sky-400/70 dark:ring-sky-500/70 font-bold"
                                                title="Cloze target hidden in Anki"
                                              >
                                                {item.cloze.target}
                                              </span>
                                            )}
                                          </React.Fragment>
                                        ))
                                      ) : (
                                        <span>{item.cloze.sentence}</span>
                                      )}
                                    </div>
                                    <div className="inline-block px-3 py-1 rounded-lg bg-slate-200/70 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300">
                                      Hint: {item.cloze.hint}
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* Editable Fields (Front + Back) */}
                              {(previewSide === 'both' || previewSide === 'back') && (
                                <div className="p-4 space-y-3 flex-1">
                                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                    Editable Fields
                                  </div>

                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                      <label className="block text-xs font-medium text-slate-500 mb-1">
                                        Term {isEdited('cloze.target') && <span className="text-amber-600">(Edited)</span>}
                                      </label>
                                      <input
                                        type="text"
                                        value={item.cloze.target}
                                        onChange={(e) => handleFieldEdit(item.id, 'cloze', 'target', e.target.value)}
                                        className={`w-full px-3 py-1.5 rounded-lg border text-base font-bold ${inputHighlightClass('cloze.target')}`}
                                      />
                                    </div>

                                    <div>
                                      <label className="block text-xs font-medium text-slate-500 mb-1">
                                        Pinyin {isEdited('cloze.pinyin') && <span className="text-amber-600">(Edited)</span>}
                                      </label>
                                      <input
                                        type="text"
                                        value={item.cloze.pinyin}
                                        onChange={(e) => handleFieldEdit(item.id, 'cloze', 'pinyin', e.target.value)}
                                        className={`w-full px-3 py-1.5 rounded-lg border text-sm font-medium text-sky-700 dark:text-sky-300 ${inputHighlightClass('cloze.pinyin')}`}
                                      />
                                    </div>
                                  </div>

                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                      <label className="block text-xs font-medium text-slate-500 mb-1">
                                        Front English Hint {isEdited('cloze.hint') && <span className="text-amber-600">(Edited)</span>}
                                      </label>
                                      <input
                                        type="text"
                                        value={item.cloze.hint}
                                        onChange={(e) => handleFieldEdit(item.id, 'cloze', 'hint', e.target.value)}
                                        className={`w-full px-3 py-1.5 rounded-lg border text-sm ${inputHighlightClass('cloze.hint')}`}
                                      />
                                    </div>

                                    <div>
                                      <label className="block text-xs font-medium text-slate-500 mb-1">
                                        Definition {isEdited('cloze.definition') && <span className="text-amber-600">(Edited)</span>}
                                      </label>
                                      <input
                                        type="text"
                                        value={item.cloze.definition}
                                        onChange={(e) => handleFieldEdit(item.id, 'cloze', 'definition', e.target.value)}
                                        className={`w-full px-3 py-1.5 rounded-lg border text-sm ${inputHighlightClass('cloze.definition')}`}
                                      />
                                    </div>
                                  </div>

                                  <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">
                                      Chinese Sentence {isEdited('cloze.sentence') && <span className="text-amber-600">(Edited)</span>}
                                    </label>
                                    <input
                                      type="text"
                                      value={item.cloze.sentence}
                                      onChange={(e) => handleFieldEdit(item.id, 'cloze', 'sentence', e.target.value)}
                                      className={`w-full px-3 py-1.5 rounded-lg border text-base font-medium ${inputHighlightClass('cloze.sentence')}`}
                                    />
                                  </div>

                                  <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">
                                      Sentence Pinyin {isEdited('cloze.sentencePinyin') && <span className="text-amber-600">(Edited)</span>}
                                    </label>
                                    <input
                                      type="text"
                                      value={item.cloze.sentencePinyin}
                                      onChange={(e) => handleFieldEdit(item.id, 'cloze', 'sentencePinyin', e.target.value)}
                                      className={`w-full px-3 py-1.5 rounded-lg border text-sm ${inputHighlightClass('cloze.sentencePinyin')}`}
                                    />
                                  </div>

                                  <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">
                                      English Sentence Translation {isEdited('cloze.sentenceTranslation') && <span className="text-amber-600">(Edited)</span>}
                                    </label>
                                    <input
                                      type="text"
                                      value={item.cloze.sentenceTranslation}
                                      onChange={(e) => handleFieldEdit(item.id, 'cloze', 'sentenceTranslation', e.target.value)}
                                      className={`w-full px-3 py-1.5 rounded-lg border text-sm ${inputHighlightClass('cloze.sentenceTranslation')}`}
                                    />
                                  </div>

                                  {/* Audio Controls */}
                                  <div className="pt-2 flex flex-wrap items-center gap-2">
                                    {renderAudioControl(item.wordAudioKey, 'Term Audio', item.cloze.target)}
                                    {renderAudioControl(item.sentenceAudioKey, 'Sentence Audio', item.cloze.sentence)}
                                  </div>
                                </div>
                              )}
                            </div>
                            )}

                            {/* ========================================================
                                CARD TYPE 2: WORD RECOGNITION CARD
                               ======================================================== */}
                            {!item.deletedRecognition && (
                            <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col bg-slate-50/40 dark:bg-slate-950/40">
                              <div className="px-4 py-2.5 bg-emerald-50/80 dark:bg-emerald-950/40 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                                <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                                  Card 2: Word Recognition Card
                                </span>
                                <div className="flex items-center gap-2">
                                  <span className="text-[11px] text-slate-500">Isolated Character Recall</span>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteIndividualCard(item.id, 'recognition')}
                                    className="p-1 text-slate-400 hover:text-red-600 rounded transition"
                                    title="Delete Word Recognition Card"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>

                              {/* Anki Card Front Preview (ONLY Chinese chunk) */}
                              {(previewSide === 'both' || previewSide === 'front') && (
                                <div className="p-4 border-b border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900">
                                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                                    Front Preview
                                  </div>
                                  <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-center flex items-center justify-center min-h-[96px]">
                                    <div className="text-3xl sm:text-4xl font-bold text-slate-900 dark:text-white tracking-wide">
                                      {item.recognition.target}
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* Editable Fields (Front + Back) */}
                              {(previewSide === 'both' || previewSide === 'back') && (
                                <div className="p-4 space-y-3 flex-1">
                                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                    Editable Fields
                                  </div>

                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                      <label className="block text-xs font-medium text-slate-500 mb-1">
                                        Term {isEdited('recognition.target') && <span className="text-amber-600">(Edited)</span>}
                                      </label>
                                      <input
                                        type="text"
                                        value={item.recognition.target}
                                        onChange={(e) => handleFieldEdit(item.id, 'recognition', 'target', e.target.value)}
                                        className={`w-full px-3 py-1.5 rounded-lg border text-base font-bold ${inputHighlightClass('recognition.target')}`}
                                      />
                                    </div>

                                    <div>
                                      <label className="block text-xs font-medium text-slate-500 mb-1">
                                        Pinyin {isEdited('recognition.pinyin') && <span className="text-amber-600">(Edited)</span>}
                                      </label>
                                      <input
                                        type="text"
                                        value={item.recognition.pinyin}
                                        onChange={(e) => handleFieldEdit(item.id, 'recognition', 'pinyin', e.target.value)}
                                        className={`w-full px-3 py-1.5 rounded-lg border text-sm font-medium text-sky-700 dark:text-sky-300 ${inputHighlightClass('recognition.pinyin')}`}
                                      />
                                    </div>
                                  </div>

                                  <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">
                                      Definition {isEdited('recognition.definition') && <span className="text-amber-600">(Edited)</span>}
                                    </label>
                                    <input
                                      type="text"
                                      value={item.recognition.definition}
                                      onChange={(e) => handleFieldEdit(item.id, 'recognition', 'definition', e.target.value)}
                                      className={`w-full px-3 py-1.5 rounded-lg border text-sm ${inputHighlightClass('recognition.definition')}`}
                                    />
                                  </div>

                                  {/* Character Component Breakdown Editor */}
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <label className="block text-xs font-medium text-slate-500">
                                        Character Component Breakdown (Radicals / Semantic / Phonetic)
                                      </label>
                                      <button
                                        type="button"
                                        onClick={() => handleAddComponentRow(item.id)}
                                        className="text-xs text-sky-600 hover:underline flex items-center gap-0.5"
                                      >
                                        <Plus className="w-3 h-3" /> Add Char
                                      </button>
                                    </div>
                                    <div className="space-y-1.5">
                                      {item.recognition.components.map((comp, cIdx) => (
                                        <div key={cIdx} className="flex items-start gap-2">
                                          <input
                                            type="text"
                                            value={comp.char}
                                            onChange={(e) =>
                                              handleComponentEdit(item.id, cIdx, 'char', e.target.value)
                                            }
                                            className={`w-12 px-2 py-1.5 rounded-lg border text-center font-bold text-base ${inputHighlightClass(
                                              `recognition.components.${cIdx}.char`
                                            )}`}
                                          />
                                          <input
                                            type="text"
                                            value={comp.explanation}
                                            onChange={(e) =>
                                              handleComponentEdit(item.id, cIdx, 'explanation', e.target.value)
                                            }
                                            className={`flex-1 px-2.5 py-1.5 rounded-lg border text-xs leading-relaxed ${inputHighlightClass(
                                              `recognition.components.${cIdx}.explanation`
                                            )}`}
                                          />
                                          {item.recognition.components.length > 1 && (
                                            <button
                                              type="button"
                                              onClick={() => handleRemoveComponentRow(item.id, cIdx)}
                                              className="p-1.5 text-slate-400 hover:text-red-500"
                                              title="Remove component row"
                                            >
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>

                                  <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1">
                                      Example Sentence {isEdited('recognition.sentence') && <span className="text-amber-600">(Edited)</span>}
                                    </label>
                                    <input
                                      type="text"
                                      value={item.recognition.sentence}
                                      onChange={(e) => handleFieldEdit(item.id, 'recognition', 'sentence', e.target.value)}
                                      className={`w-full px-3 py-1.5 rounded-lg border text-base font-medium ${inputHighlightClass('recognition.sentence')}`}
                                    />
                                  </div>

                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                      <label className="block text-xs font-medium text-slate-500 mb-1">
                                        Sentence Pinyin {isEdited('recognition.sentencePinyin') && <span className="text-amber-600">(Edited)</span>}
                                      </label>
                                      <input
                                        type="text"
                                        value={item.recognition.sentencePinyin}
                                        onChange={(e) =>
                                          handleFieldEdit(item.id, 'recognition', 'sentencePinyin', e.target.value)
                                        }
                                        className={`w-full px-3 py-1.5 rounded-lg border text-xs ${inputHighlightClass('recognition.sentencePinyin')}`}
                                      />
                                    </div>

                                    <div>
                                      <label className="block text-xs font-medium text-slate-500 mb-1">
                                        English Translation {isEdited('recognition.sentenceTranslation') && <span className="text-amber-600">(Edited)</span>}
                                      </label>
                                      <input
                                        type="text"
                                        value={item.recognition.sentenceTranslation}
                                        onChange={(e) =>
                                          handleFieldEdit(item.id, 'recognition', 'sentenceTranslation', e.target.value)
                                        }
                                        className={`w-full px-3 py-1.5 rounded-lg border text-xs ${inputHighlightClass('recognition.sentenceTranslation')}`}
                                      />
                                    </div>
                                  </div>

                                  {/* Audio Controls */}
                                  <div className="pt-2 flex flex-wrap items-center gap-2">
                                    {renderAudioControl(item.wordAudioKey, 'Term Audio', item.recognition.target)}
                                    {renderAudioControl(item.sentenceAudioKey, 'Sentence Audio', item.recognition.sentence)}
                                  </div>
                                </div>
                              )}
                            </div>
                            )}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>

                {/* Bottom Navigation Button to Return to Export Section */}
                <div className="pt-2 pb-4 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setShowStageBAddModal(true)}
                    className="px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium text-slate-700 dark:text-slate-200 shadow-xs transition flex items-center gap-2"
                  >
                    <Plus className="w-4 h-4 text-sky-600" />
                    <span>Add Term</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (exportSectionRef.current) {
                        exportSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      } else {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }
                    }}
                    className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-sm transition flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    <span>Go to Export</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ====================================================================
            STAGE 5: PERSISTENT VOCABULARY HISTORY & DUPLICATE MANAGEMENT
           ==================================================================== */}
        {activeTab === 'history' && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 shadow-sm space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                  Card History ({Object.keys(vocabHistory).length})
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Exported terms are saved so you can avoid duplicate cards in future sessions.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleExportHistoryJson}
                  className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Backup History JSON</span>
                </button>

                <label className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Restore History JSON</span>
                  <input type="file" accept=".json" onChange={handleImportHistoryJson} className="hidden" />
                </label>
              </div>
            </div>

            {!storageAvailable && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                Browser persistent storage is restricted in this environment. Use "Backup History JSON" and "Restore History JSON" above to preserve your vocabulary history across sessions.
              </div>
            )}

            <div className="relative max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Search Chinese word, pinyin, or English definition..."
                className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>

            {filteredHistoryList.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-500">
                {Object.keys(vocabHistory).length === 0
                  ? 'No exported vocabulary in history yet. Export an .apkg deck to automatically record your learned terms.'
                  : 'No matching vocabulary entries found.'}
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-800 text-xs uppercase text-slate-500">
                      <th className="py-3 px-4">Chinese</th>
                      <th className="py-3 px-4">Pinyin</th>
                      <th className="py-3 px-4">Definition</th>
                      <th className="py-3 px-4">Example Sentence</th>
                      <th className="py-3 px-4">Exported</th>
                      <th className="py-3 px-4 text-right">Remove</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {filteredHistoryList.map((entry) => (
                      <tr key={entry.chunk}>
                        <td className="py-3 px-4 font-bold text-base">{entry.chunk}</td>
                        <td className="py-3 px-4 text-sky-600 dark:text-sky-400 font-medium">{entry.pinyin}</td>
                        <td className="py-3 px-4">{entry.definition}</td>
                        <td className="py-3 px-4 text-slate-600 dark:text-slate-300">{entry.sentence}</td>
                        <td className="py-3 px-4 text-xs text-slate-400">
                          {entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : '—'}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              setVocabHistory((prev) => {
                                const copy = { ...prev };
                                delete copy[entry.chunk];
                                return copy;
                              })
                            }
                            className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg"
                            title="Delete from history"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ====================================================================
          MODAL: ADD TERM IN STAGE A (INPUT PREVIEW)
         ==================================================================== */}
      {showStageAAddModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleAddTermStageA}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                Add Term to Input Preview
              </h3>
              <button
                type="button"
                onClick={() => setShowStageAAddModal(false)}
                className="text-sm text-slate-400 hover:text-slate-600"
              >
                Close
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Chinese Vocabulary Term *
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={stageANewTerm}
                  onChange={(e) => setStageANewTerm(e.target.value)}
                  placeholder="e.g. 学习"
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-base font-bold text-slate-900 dark:text-white focus:ring-2 focus:ring-sky-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Custom Chinese Sentence (Optional)
                </label>
                <input
                  type="text"
                  value={stageANewSentence}
                  onChange={(e) => setStageANewSentence(e.target.value)}
                  placeholder="Leave blank to auto-generate sentence"
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-sky-500 outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowStageAAddModal(false)}
                className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!stageANewTerm.trim()}
                className="px-5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-xs font-semibold"
              >
                Add Term
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ====================================================================
          MODAL: ADD TERM IN STAGE B (AFTER INITIAL CARD GENERATION)
         ==================================================================== */}
      {showStageBAddModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleAddTermStageB}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                Add Term & Generate Cards
              </h3>
              <button
                type="button"
                disabled={isAddingStageBTerm}
                onClick={() => setShowStageBAddModal(false)}
                className="text-sm text-slate-400 hover:text-slate-600 disabled:opacity-50"
              >
                Close
              </button>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              Generates 1 Sentence Cloze Card and 1 Word Recognition Card and appends them to your deck without modifying existing cards.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Chinese Vocabulary Term *
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  disabled={isAddingStageBTerm}
                  value={stageBNewTerm}
                  onChange={(e) => setStageBNewTerm(e.target.value)}
                  placeholder="e.g. 发现"
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-base font-bold text-slate-900 dark:text-white focus:ring-2 focus:ring-sky-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                  Custom Chinese Sentence (Optional)
                </label>
                <input
                  type="text"
                  disabled={isAddingStageBTerm}
                  value={stageBNewSentence}
                  onChange={(e) => setStageBNewSentence(e.target.value)}
                  placeholder="Leave blank to auto-generate sentence"
                  className="w-full px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-sky-500 outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={isAddingStageBTerm}
                onClick={() => setShowStageBAddModal(false)}
                className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isAddingStageBTerm || !stageBNewTerm.trim()}
                className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5"
              >
                {isAddingStageBTerm ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Generating 2 Cards...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Generate 2 Cards</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ====================================================================
          MODAL: CONFIRM REGENERATION WHEN MANUAL EDITS EXIST
         ==================================================================== */}
      {confirmRegenModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4">
            <div className="flex items-center gap-2.5 text-amber-600">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                Preserve Manual Edits?
              </h3>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              You have manually edited fields on <strong>{confirmRegenModal.cardItem.chunk}</strong>. How would you like to proceed?
            </p>
            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={() =>
                  executeRegenerateCard(confirmRegenModal.cardItem, confirmRegenModal.mode, false)
                }
                className="w-full py-2.5 px-4 rounded-xl bg-sky-600 hover:bg-sky-700 text-white font-semibold text-sm"
              >
                Regenerate Unedited Fields Only (Keep My Edits)
              </button>
              <button
                type="button"
                onClick={() =>
                  executeRegenerateCard(confirmRegenModal.cardItem, confirmRegenModal.mode, true)
                }
                className="w-full py-2.5 px-4 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold text-sm"
              >
                Overwrite Everything with Fresh AI Content
              </button>
              <button
                type="button"
                onClick={() => setConfirmRegenModal(null)}
                className="w-full py-2 px-4 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          MODAL: SETUP, API CONFIGURATION & ANKI IMPORT INSTRUCTIONS
         ==================================================================== */}
      {showApiHelpModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                Configuration & Anki Import Guide
              </h3>
              <button
                type="button"
                onClick={() => setShowApiHelpModal(false)}
                className="text-sm text-slate-400 hover:text-slate-600"
              >
                Close
              </button>
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-300 space-y-3 leading-relaxed">
              <div>
                <strong className="text-slate-900 dark:text-white">1. AI &amp; Mandarin TTS Services (Session API Key):</strong>
                <p>
                  Paste your Gemini API key into the <strong>Gemini API Key</strong> bar at the top of the page. Your key is kept strictly in browser memory for your current session and is cleared automatically when you close or refresh the tab—it is never saved to <code>localStorage</code> or included in exported decks.
                </p>
              </div>
              <div>
                <strong className="text-slate-900 dark:text-white">2. Genuine .apkg Packaging:</strong>
                <p>
                  When you click <strong>Export Genuine Anki (.apkg)</strong>, the app compiles an in-browser SQLite database (<code>collection.anki2</code>) with two custom note types (<em>Chinese Vocab - Sentence Cloze</em> and <em>Chinese Vocab - Word Recognition</em>) and bundles all generated WAV audio files into the media archive.
                </p>
              </div>
              <div>
                <strong className="text-slate-900 dark:text-white">3. Importing into Anki:</strong>
                <p>
                  Open Anki on Desktop or Mobile (AnkiMobile / AnkiDroid), select <strong>File → Import</strong>, and choose your downloaded <code>.apkg</code> file. Both card types and all offline audio files will appear immediately in your chosen deck.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}