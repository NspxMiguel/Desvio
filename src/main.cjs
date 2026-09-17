'use strict';

const { app, BrowserWindow, ipcMain, Notification, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const dotenv = require('dotenv');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const signature = require('./core/signature.cjs');
const fingerprint = require('./core/ai-fingerprint.cjs');
const contactId = require('./core/contact-id.cjs');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_ENDPOINT = 'https://api.groq.com/openai/v1/models';

// Groq retires model names without warning: the first default this app shipped
// with started answering 404 the same week. Preference order, and a live check
// that repairs the setting instead of failing on every message.
const PREFERRED_MODELS = ['openai/gpt-oss-20b', 'groq/compound-mini', 'openai/gpt-oss-120b'];
const NON_CHAT_MODELS = /whisper|orpheus|prompt-guard|tts|guard/i;
const MEDIA_SCHEME = 'desvio-media';
const MEDIA_CACHE_LIMIT = 40;
const MAX_MEDIA_BYTES = 80 * 1024 * 1024;
const RECENT_LIMIT = 40;

// Two Desvio users talking to each other would answer each other forever. Auto
// replies are capped per person and never fire at a message that already carries
// the marker.
const AUTO_REPLY_WINDOW_MS = 10 * 60 * 1000;
const AUTO_REPLY_MAX_PER_WINDOW = 4;

const HISTORY_WINDOWS = {
  '7d': { days: 7, perChat: 500 },
  '30d': { days: 30, perChat: 1500 },
  '90d': { days: 90, perChat: 3000 },
  '365d': { days: 365, perChat: 6000 },
  all: { days: null, perChat: 20000 }
};

const defaultSettings = {
  language: 'system',
  theme: 'system',
  groqApiKey: '',
  model: 'openai/gpt-oss-20b',
  defaultStyle: 'Warm, brief and casual. Reply in the language the person used.',
  contacts: [],
  learning: { enabled: true, maxSamples: 160, historyWindow: '7d' },
  writingSamples: [],
  watchEveryone: true,
  webhook: { enabled: false, url: '', token: '' }
};

let mainWindow = null;
let client = null;
let storePath = '';
let mediaDir = '';
let storeTimer = null;
const autoReplyLog = new Map();

let state = {
  connection: 'disconnected',
  qr: null,
  settings: defaultSettings,
  pending: [],
  recent: [],
  groqModels: [],
  learning: { status: 'idle', imported: 0, skipped: 0, failed: 0, chats: 0, chatsTotal: 0 },
  error: null
};

/* ------------------------------------------------------------------ storage */

function readStore() {
  try {
    const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return {
      ...defaultSettings,
      ...saved,
      learning: { ...defaultSettings.learning, ...(saved.learning || {}) },
      webhook: { ...defaultSettings.webhook, ...(saved.webhook || {}) },
      contacts: Array.isArray(saved.contacts) ? saved.contacts : [],
      writingSamples: Array.isArray(saved.writingSamples) ? saved.writingSamples : []
    };
  } catch {
    return { ...defaultSettings };
  }
}

function writeStore() {
  try {
    fs.writeFileSync(storePath, JSON.stringify(state.settings, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('Could not save settings:', error.message);
  }
}

// Learning writes one sample per sent message; batching keeps that off the disk
// on every keystroke of a conversation.
function scheduleStoreWrite() {
  if (storeTimer) return;
  storeTimer = setTimeout(() => {
    storeTimer = null;
    writeStore();
  }, 1500);
}

function publicState() {
  const { groqApiKey, webhook, writingSamples, ...safeSettings } = state.settings;
  return {
    ...state,
    settings: {
      ...safeSettings,
      webhook: { ...webhook, token: '', tokenConfigured: Boolean(webhook.token) },
      groqConfigured: Boolean(groqApiKey || process.env.GROQ_API_KEY),
      // DESVIO_LANG=pt forces the interface language for a single run, which is
      // how the translation gets checked without touching the machine's own.
      forcedLanguage: process.env.DESVIO_LANG || '',
      sampleCount: (writingSamples || []).length
    }
  };
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:changed', publicState());
  }
}

function fail(message) {
  state.error = message;
  broadcast();
}

/* ------------------------------------------------------------------ learning */

// The owner also sends text some other assistant wrote for him. Those messages
// carry no Desvio marker, so the same reading shown by the live meter next to his
// typing is what decides whether a sent message becomes a sample.
function storeWritingSamples(samples) {
  const maximum = Math.max(20, Math.min(Number(state.settings.learning.maxSamples) || 160, 400));
  const current = state.settings.writingSamples || [];
  const known = new Set(current.map((sample) => `${sample.contactId}|${sample.body}`));
  const fresh = [];
  let skipped = 0;
  for (const sample of samples) {
    const key = `${sample.contactId}|${sample.body}`;
    if (known.has(key)) continue;
    if (signature.isSigned(sample.body) || !fingerprint.worthLearningFrom(sample.body)) {
      skipped += 1;
      continue;
    }
    known.add(key);
    fresh.push(sample);
  }
  state.learning.skipped += skipped;
  if (!fresh.length) return 0;
  state.settings.writingSamples = [...fresh, ...current].slice(0, maximum);
  scheduleStoreWrite();
  return fresh.length;
}

function learnFromOwnMessage(message) {
  if (!state.settings.learning.enabled) return;
  const body = String(message.body || '').trim();
  if (!body || signature.isSigned(body)) return;
  if (!contactId.isPersonId(message.to)) return;
  storeWritingSamples([
    {
      body,
      contactId: contactId.userPartOf(message.to),
      createdAt: new Date().toISOString()
    }
  ]);
  broadcast();
}

function writingExamples(whatsappId) {
  const samples = state.settings.writingSamples || [];
  if (!samples.length) {
    return 'No samples yet. Follow the configured style and do not invent slang.';
  }
  const user = contactId.userPartOf(whatsappId);
  const forContact = samples.filter((sample) => contactId.sameContact(sample.contactId, user));
  const others = samples.filter((sample) => !contactId.sameContact(sample.contactId, user));
  return [...forContact, ...others]
    .slice(0, 24)
    .map((sample) => `- ${sample.body}`)
    .join('\n');
}

function historyCutoff() {
  const window = HISTORY_WINDOWS[state.settings.learning.historyWindow] || HISTORY_WINDOWS['7d'];
  if (window.days === null) return { cutoff: 0, perChat: window.perChat };
  return {
    cutoff: Math.floor(Date.now() / 1000) - window.days * 24 * 60 * 60,
    perChat: window.perChat
  };
}

async function importWritingHistory() {
  if (!client || state.connection !== 'ready') {
    throw new Error('Connect WhatsApp before importing history.');
  }
  if (state.learning.status === 'importing') return;

  const { cutoff, perChat } = historyCutoff();
  state.learning = {
    status: 'importing',
    imported: 0,
    skipped: 0,
    failed: 0,
    chats: 0,
    chatsTotal: 0
  };
  broadcast();
  try {
    const chats = (await client.getChats()).filter(
      (chat) => !chat.isGroup && contactId.isPersonId(chat.id?._serialized)
    );
    // A conversation whose last activity predates the window has nothing to give.
    const relevant = chats.filter((chat) => !cutoff || (chat.timestamp || 0) >= cutoff);
    state.learning.chatsTotal = relevant.length;
    broadcast();

    for (const chat of relevant) {
      let messages;
      try {
        // limit must be a finite number: page.evaluate serializes arguments as JSON
        // and Infinity becomes null, which silently disables the paging loop and
        // returns only whatever WhatsApp Web already had in memory.
        messages = await chat.fetchMessages({ limit: perChat, fromMe: true });
      } catch (error) {
        // Reading older messages means calling into WhatsApp Web's own bundle,
        // whose module names change between releases and throw a single minified
        // letter when they move. Without a limit the library skips that path and
        // returns what the page already holds: less history, but history.
        console.warn(`Paged history failed for one chat (${error.message}); using memory only.`);
        try {
          messages = await chat.fetchMessages({ fromMe: true });
        } catch (fallbackError) {
          console.warn(`Skipping one chat: ${fallbackError.message}`);
          state.learning.failed += 1;
          state.learning.chats += 1;
          broadcast();
          continue;
        }
      }
      const samples = messages
        .filter((message) => message.timestamp >= cutoff && String(message.body || '').trim())
        .map((message) => ({
          body: message.body.trim(),
          contactId: contactId.userPartOf(chat.id._serialized),
          createdAt: new Date(message.timestamp * 1000).toISOString()
        }));
      state.learning.imported += storeWritingSamples(samples);
      state.learning.chats += 1;
      broadcast();
    }
    writeStore();
    state.learning.status = 'ready';
  } catch (error) {
    console.error('History import failed:', error);
    state.learning.status = 'error';
    state.error = `Writing history could not be imported: ${error.message || error}`;
  }
  broadcast();
}

/* ---------------------------------------------------------------------- groq */

function groqKey() {
  return state.settings.groqApiKey || process.env.GROQ_API_KEY || '';
}

async function askModel(prompt, { temperature = 0.5 } = {}) {
  const apiKey = groqKey();
  if (!apiKey) throw new Error('Add a Groq API key in Settings first.');
  const response = await fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': `desvio/${app.getVersion()}`
    },
    body: JSON.stringify({
      model: state.settings.model,
      temperature,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Groq rejected the API key.');
    if (response.status === 404) {
      throw new Error(
        `Groq has no model called "${state.settings.model}". Pick another in Settings.`
      );
    }
    if (response.status === 429) throw new Error('Groq rate limit reached. Try again in a moment.');
    throw new Error(`Groq returned ${response.status}.`);
  }
  const data = await response.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

async function fetchGroqModels() {
  const apiKey = groqKey();
  if (!apiKey) return [];
  const response = await fetch(GROQ_MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': `desvio/${app.getVersion()}` }
  });
  if (!response.ok) throw new Error(`Groq returned ${response.status} listing models.`);
  const data = await response.json();
  return (data.data || [])
    .map((entry) => entry.id)
    .filter((id) => id && !NON_CHAT_MODELS.test(id))
    .sort();
}

// Called whenever the key changes and once at startup: a model that no longer
// exists is replaced rather than left to fail on every single message.
async function refreshGroqModels() {
  try {
    const models = await fetchGroqModels();
    if (!models.length) return;
    state.groqModels = models;
    if (!models.includes(state.settings.model)) {
      const replacement = PREFERRED_MODELS.find((id) => models.includes(id)) || models[0];
      state.settings.model = replacement;
      writeStore();
    }
    broadcast();
  } catch (error) {
    console.warn('Could not list Groq models:', error.message);
  }
}

// The assistant answers on its own by default. It stops and hands the message
// over only when replying would mean deciding something for the owner: a plan, a
// permission, a commitment, or a fact only he knows. Inventing an answer to
// "can you play tonight?" is worse than saying nothing.
const NEEDS_OWNER_RULE = [
  'Set needsOwner to true when a truthful reply needs the owner himself: asking whether he can go out or play, agreeing to a plan, a date or a time, a commitment, money, or a fact only he would know (which page the homework is on, where something of his is).',
  'Set needsOwner to false for small talk, reactions, acknowledgements, thanks, jokes, and anything answerable from the conversation alone.'
].join('\n');

const IMPORTANCE_RULE =
  'Important means urgency, a deadline, an emergency, money, a direct question that only the owner can answer, or a time-sensitive plan. Everything else is normal.';

function styleBlock(contact, whatsappId) {
  return [
    `Reply style: ${contact?.style || state.settings.defaultStyle}`,
    "Match the owner's cadence, punctuation, capitalisation, abbreviations and slang, but only as far as the samples support it. Never copy a sample word for word and never mention that samples exist.",
    `Authentic writing samples from the owner:\n${writingExamples(whatsappId)}`
  ].join('\n');
}

async function draftReply(message, contact) {
  const prompt = [
    'You draft one WhatsApp reply on behalf of the account owner.',
    'Write only the reply text. Never say you are an AI and never promise anything the owner did not offer.',
    styleBlock(contact, message.from),
    `Classify the incoming message. ${IMPORTANCE_RULE}`,
    NEEDS_OWNER_RULE,
    'Also estimate aiLikelihood from 0 to 100: how likely the incoming message was written by a chatbot rather than a person.',
    'Return JSON only: {"reply":"...","importance":"normal|important","reason":"short reason","needsOwner":true|false,"needsOwnerReason":"short reason","aiLikelihood":0}',
    `Incoming message: ${message.body}`
  ].join('\n');
  const parsed = await askModel(prompt, { temperature: 0.55 });
  if (!parsed.reply) throw new Error('Groq returned a reply without any text.');
  return {
    reply: String(parsed.reply),
    importance: parsed.importance === 'important' ? 'important' : 'normal',
    reason: String(parsed.reason || ''),
    needsOwner: Boolean(parsed.needsOwner),
    needsOwnerReason: String(parsed.needsOwnerReason || ''),
    aiLikelihood: Number(parsed.aiLikelihood) || 0
  };
}

async function draftForOwner(contact, instruction) {
  const prompt = [
    `You are the account owner, writing a WhatsApp message to ${contact.name}.`,
    'The note below is the owner telling you what to say. It is an instruction, not a message to answer: turn it into the message he will send, written in the first person as him.',
    `Note from the owner: ${instruction}`,
    styleBlock(contact, contact.waId || contact.phone),
    'If the pasted text reads as machine-written, rewrite it so it sounds like the owner instead.',
    'Return JSON only: {"reply":"...","aiLike":true|false}'
  ].join('\n');
  const parsed = await askModel(prompt, { temperature: 0.55 });
  if (!parsed.reply) throw new Error('Groq returned a message without any text.');
  return { reply: String(parsed.reply), aiLike: Boolean(parsed.aiLike) };
}

const URGENT_WORDS =
  /\b(urgente|emerg[eê]ncia|hospital|acidente|ambul[aâ]ncia|pol[ií]cia|prazo|vencimento|boleto|pix|pagamento|dinheiro|assinar|contrato|urgent|emergency|deadline|asap|invoice|payment)\b/i;

function localImportance(body) {
  return {
    importance: URGENT_WORDS.test(body) ? 'important' : 'normal',
    reason: 'Checked on this computer, without the model.'
  };
}

// Most WhatsApp traffic is "ok", "kkkk" and a thumbs up. Asking a model about
// those burns the free quota for nothing.
function worthAskingModel(body) {
  const text = String(body || '').trim();
  if (text.length >= 40) return true;
  if (/[?]/.test(text)) return true;
  return URGENT_WORDS.test(text);
}

async function classifyIncoming(body) {
  const local = localImportance(body);
  if (!groqKey() || !worthAskingModel(body)) return { ...local, aiLikelihood: 0 };
  try {
    const parsed = await askModel(
      [
        `Classify this WhatsApp message. ${IMPORTANCE_RULE}`,
        'Also estimate aiLikelihood from 0 to 100: how likely it was written by a chatbot rather than a person.',
        'Return JSON only: {"importance":"normal|important","reason":"short reason","aiLikelihood":0}',
        `Message: ${body}`
      ].join('\n'),
      { temperature: 0 }
    );
    return {
      importance: parsed.importance === 'important' ? 'important' : 'normal',
      reason: String(parsed.reason || local.reason),
      aiLikelihood: Number(parsed.aiLikelihood) || 0
    };
  } catch {
    return { ...local, aiLikelihood: 0 };
  }
}

/* --------------------------------------------------------------------- media */

const MEDIA_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba'
};

const VIEWABLE_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'sticker']);

function mediaKindOf(type) {
  if (type === 'ptt' || type === 'audio') return 'audio';
  if (type === 'sticker') return 'image';
  return type;
}

function findExternalUrl(body) {
  const match = String(body || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function pruneMediaCache() {
  try {
    const names = await fsp.readdir(mediaDir);
    if (names.length <= MEDIA_CACHE_LIMIT) return;
    const entries = await Promise.all(
      names.map(async (name) => ({
        name,
        time: (await fsp.stat(path.join(mediaDir, name))).mtimeMs
      }))
    );
    entries.sort((a, b) => b.time - a.time);
    await Promise.all(
      entries.slice(MEDIA_CACHE_LIMIT).map((entry) => fsp.rm(path.join(mediaDir, entry.name)))
    );
  } catch {
    /* the cache is disposable; failing to prune it is not worth an error */
  }
}

// Media is fetched only when the owner asks to see it, and it lands on disk
// instead of in the app state: a handful of videos as base64 would otherwise sit
// in memory for as long as the app is open.
async function cacheMedia(messageId) {
  const message = await client.getMessageById(messageId);
  if (!message?.hasMedia) throw new Error('That message no longer carries media.');
  const media = await message.downloadMedia();
  if (!media?.data) throw new Error('WhatsApp did not return the media.');
  const buffer = Buffer.from(media.data, 'base64');
  if (buffer.byteLength > MAX_MEDIA_BYTES) throw new Error('That file is too large to preview.');
  const extension = MEDIA_EXTENSIONS[media.mimetype?.split(';')[0]] || 'bin';
  const name = `${messageId.replace(/[^A-Za-z0-9_-]/g, '')}.${extension}`;
  await fsp.mkdir(mediaDir, { recursive: true });
  await fsp.writeFile(path.join(mediaDir, name), buffer);
  pruneMediaCache();
  return {
    url: `${MEDIA_SCHEME}://file/${name}`,
    kind: mediaKindOf(message.type),
    mimetype: media.mimetype
  };
}

// WhatsApp migrated accounts to LID addressing: the phone book still reports
// 554792078506@c.us while the account's real, sendable id is now something like
// 220301992398854@lid. Sending to the phone-shaped id reaches nobody, so the id
// is resolved once per contact and kept.
async function resolveChatId(contact) {
  if (contact.waId && contact.waId.includes('@')) return contact.waId;
  const numberId = await client.getNumberId(contactId.userPartOf(contact.phone));
  if (!numberId?._serialized) {
    throw new Error(`${contact.name} does not look like a WhatsApp account.`);
  }
  const stored = state.settings.contacts.find((candidate) => candidate.id === contact.id);
  if (stored) {
    stored.waId = numberId._serialized;
    writeStore();
    broadcast();
  }
  return numberId._serialized;
}

// whatsapp-web.js can resolve sendMessage with an empty result when WhatsApp Web
// moves under it: no error, no message, and the app would happily report a send
// that never happened. Nothing is treated as sent unless WhatsApp gave it an id.
async function sendAndConfirm(chatId, text) {
  if (!client) throw new Error('WhatsApp is not connected.');
  const sent = await client.sendMessage(chatId, text);
  if (!sent?.id?._serialized) {
    throw new Error(
      'WhatsApp accepted nothing back: the message was not sent. This build of WhatsApp Web is ahead of the library.'
    );
  }
  return sent;
}

/* ------------------------------------------------------------------ messages */

function contactKey(whatsappId) {
  return contactId.userPartOf(whatsappId);
}

function canAutoReply(whatsappId) {
  const key = contactKey(whatsappId);
  const now = Date.now();
  const recent = (autoReplyLog.get(key) || []).filter((time) => now - time < AUTO_REPLY_WINDOW_MS);
  autoReplyLog.set(key, recent);
  return recent.length < AUTO_REPLY_MAX_PER_WINDOW;
}

function recordAutoReply(whatsappId) {
  const key = contactKey(whatsappId);
  autoReplyLog.set(key, [...(autoReplyLog.get(key) || []), Date.now()]);
}

async function notifyImportant(item) {
  if (item.importance !== 'important') return;
  if (Notification.isSupported()) {
    new Notification({
      title: `Desvio · ${item.name}`,
      body: item.body || item.mediaLabel || '…'
    }).show();
  }
  await sendWebhook(item);
}

async function sendWebhook(item) {
  const webhook = state.settings.webhook;
  if (!webhook.enabled || !webhook.url) return;
  try {
    await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(webhook.token ? { Authorization: `Bearer ${webhook.token}` } : {})
      },
      body: JSON.stringify({
        source: 'desvio',
        type: 'important_message',
        name: item.name,
        body: item.body,
        reason: item.reason,
        receivedAt: item.receivedAt
      })
    });
  } catch (error) {
    console.warn('Webhook failed:', error.message);
  }
}

function pushRecent(item) {
  state.recent = [item, ...state.recent.filter((entry) => entry.id !== item.id)].slice(
    0,
    RECENT_LIMIT
  );
}

function baseItem(message, name) {
  const body = String(message.body || '');
  return {
    id: message.id._serialized,
    contactId: message.from,
    name,
    body,
    hasMedia: Boolean(message.hasMedia) && VIEWABLE_TYPES.has(message.type),
    mediaKind: mediaKindOf(message.type),
    externalUrl: findExternalUrl(body),
    receivedAt: new Date().toISOString()
  };
}

async function handleIncoming(message) {
  if (message.fromMe) return;
  if (!contactId.isPersonId(message.from)) return;
  const body = String(message.body || '').trim();
  if (!body && !message.hasMedia) return;

  const contact = contactId.findContact(state.settings.contacts, message.from);
  const answers = contact && contact.enabled !== false && contact.mode !== 'disabled';
  const name = contact?.name || message.notifyName || contactId.displayNumber(message.from);
  const local = fingerprint.inspect(message.body);

  // Watching for important messages covers every conversation. The allow-list
  // only decides who gets an answer back.
  if (!answers) {
    if (!state.settings.watchEveryone) return;
    const verdict = await classifyIncoming(body);
    const item = {
      ...baseItem(message, name),
      importance: verdict.importance,
      reason: verdict.reason,
      ai: fingerprint.blend(local, verdict.aiLikelihood)
    };
    pushRecent(item);
    await notifyImportant(item);
    broadcast();
    return;
  }

  try {
    const draft = await draftReply(message, contact);
    const item = {
      ...baseItem(message, name),
      reply: draft.reply,
      importance: draft.importance,
      reason: draft.reason,
      needsOwner: draft.needsOwner,
      needsOwnerReason: draft.needsOwnerReason,
      ai: fingerprint.blend(local, draft.aiLikelihood)
    };
    pushRecent(item);
    await notifyImportant(item);

    const isMachine = item.ai.level === 'certain';
    // Answering on its own is the normal case. A question only the owner can
    // answer goes to him instead, even when the contact is set to reply alone.
    const canAnswerAlone = contact.mode === 'auto' && !draft.needsOwner;
    if (canAnswerAlone && !isMachine && canAutoReply(message.from)) {
      recordAutoReply(message.from);
      await sendAndConfirm(message.from, signature.sign(draft.reply));
      item.sent = true;
    } else {
      state.pending = [item, ...state.pending.filter((entry) => entry.id !== item.id)];
    }
    broadcast();
  } catch (error) {
    fail(error.message);
  }
}

// DESVIO_DEMO="text" pushes one synthetic incoming message through the real
// pipeline — allow-list lookup, Groq draft, AI reading, importance — without a
// linked account. It is how the reply path gets exercised before anyone scans a
// QR code, and how the screenshots show the actual product instead of an empty
// inbox. Nothing here runs unless the variable is set.
async function injectDemoMessage(text) {
  const contact = state.settings.contacts.find(
    (candidate) => candidate.enabled !== false && candidate.mode !== 'disabled'
  );
  if (!contact) {
    fail('Add someone under People before running a demo message.');
    return;
  }
  const from = contact.waId || contactId.toWhatsAppId(contact.phone);
  await handleIncoming({
    id: { _serialized: `demo_${Date.now()}` },
    from,
    fromMe: false,
    body: text,
    hasMedia: false,
    type: 'chat',
    notifyName: contact.name
  });
}

// DESVIO_PROBE=<number> connects, interrogates the live WhatsApp Web page and
// prints what still works, then quits. WhatsApp changes its internals faster than
// the library tracks them, and when a call starts failing the useful question is
// which ones — not the minified letter the page throws.
async function runProbe(target) {
  const report = {};
  const phoneTail = String(target).slice(-8);
  const tryIt = async (name, run) => {
    try {
      report[name] = await run();
    } catch (error) {
      report[name] = `FAILED: ${error.message}`;
    }
  };

  await tryIt('helpers', () =>
    client.pupPage.evaluate(() => Object.keys(window.WWebJS || {}).sort())
  );
  await tryIt('getChats', async () => (await client.getChats()).length);
  await tryIt('getContacts', async () => (await client.getContacts()).length);
  await tryIt('numberId', async () => {
    const id = await client.getNumberId(target);
    return id ? id._serialized : 'not a WhatsApp account';
  });
  await tryIt('contactShape', async () => {
    const contacts = await client.getContacts();
    const mine = contacts.filter((contact) => contact.isMyContact && !contact.isGroup);
    const hit = mine.find((contact) => String(contact.number || '').includes(target.slice(-8)));
    const sample = (contact) =>
      contact && {
        serialized: contact.id?._serialized,
        server: contact.id?.server,
        user: contact.id?.user,
        number: contact.number,
        name: contact.name,
        lid: contact.lid?._serialized || contact.lid || null
      };
    return { total: mine.length, target: sample(hit), firstThree: mine.slice(0, 3).map(sample) };
  });
  await tryIt('sendPath', async () => {
    const id = await client.getNumberId(target);
    return id ? { serialized: id._serialized, server: id.server, user: id.user } : null;
  });
  await tryIt('rawStore', () =>
    client.pupPage.evaluate((phone) => {
      const store = window.Store || {};
      const out = { keys: Object.keys(store).length, hasChat: Boolean(store.Chat) };
      try {
        const chats = store.Chat.getModelsArray();
        out.chatCount = chats.length;
        const match = chats.find((chat) => String(chat.id?._serialized || '').includes(phone));
        if (match) {
          out.foundBy = 'phone';
          out.chatId = match.id._serialized;
        } else {
          out.foundBy = 'none';
          out.sampleIds = chats.slice(0, 5).map((chat) => chat.id?._serialized);
        }
        const target = match || chats.find((chat) => !chat.isGroup);
        if (target) {
          out.probeChatId = target.id?._serialized;
          out.lastMessages = target.msgs
            .getModelsArray()
            .slice(-4)
            .map((message) => ({
              fromMe: message.id?.fromMe,
              body: String(message.body || '').slice(0, 60),
              t: message.t
            }));
        }
      } catch (error) {
        out.error = String(error && error.message);
      }
      return out;
    }, phoneTail)
  );
  await tryIt('me', () => client.info?.wid?._serialized || null);
  await tryIt('sendToSelf', async () => {
    const own = client.info?.wid?._serialized;
    if (!own) return 'no own id';
    const sent = await client.sendMessage(own, 'Desvio: teste de envio, pode ignorar');
    return { id: sent?.id?._serialized || null, to: sent?.to || null, ack: sent?.ack };
  });
  await tryIt('chat', async () => {
    const chat = await client.getChatById(`${target}@c.us`);
    const messages = await chat.fetchMessages({ limit: 6 });
    return {
      name: chat.name,
      lastMessages: messages.map((message) => ({
        fromMe: message.fromMe,
        at: new Date(message.timestamp * 1000).toISOString(),
        body: String(message.body || '').slice(0, 70)
      }))
    };
  });

  console.log('PROBE ' + JSON.stringify(report, null, 2));
}

/* ------------------------------------------------------------------ whatsapp */

function chromeExecutable() {
  if (process.env.DESVIO_CHROME_PATH) return process.env.DESVIO_CHROME_PATH;
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium'
        ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function connectWhatsApp() {
  if (client) return;
  state.connection = 'connecting';
  state.error = null;
  broadcast();

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'desvio',
      dataPath: path.join(app.getPath('userData'), 'whatsapp')
    }),
    puppeteer: {
      headless: true,
      executablePath: chromeExecutable(),
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', async (qr) => {
    state.qr = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
    state.connection = 'scan_qr';
    broadcast();
  });
  client.on('authenticated', () => {
    state.connection = 'authenticating';
    state.qr = null;
    broadcast();
  });
  client.on('ready', () => {
    state.connection = 'ready';
    state.qr = null;
    state.error = null;
    broadcast();
    if (process.env.DESVIO_PROBE) {
      runProbe(process.env.DESVIO_PROBE)
        .catch((error) => console.error('PROBE crashed:', error))
        .finally(() => app.quit());
      return;
    }
    if (state.settings.learning.enabled) {
      importWritingHistory().catch((error) => fail(error.message));
    }
  });
  client.on('auth_failure', (reason) => {
    state.connection = 'error';
    fail(`WhatsApp refused the session: ${reason}`);
  });
  client.on('disconnected', (reason) => {
    client = null;
    state.connection = 'disconnected';
    fail(`WhatsApp disconnected: ${reason}`);
  });
  client.on('message', (message) => {
    handleIncoming(message).catch((error) => fail(error.message));
  });
  client.on('message_create', (message) => {
    if (message.fromMe) learnFromOwnMessage(message);
  });

  try {
    await client.initialize();
  } catch (error) {
    client = null;
    state.connection = 'error';
    fail(`Could not start the WhatsApp session: ${error.message}`);
  }
}

async function disconnectWhatsApp() {
  const current = client;
  client = null;
  state.connection = 'disconnected';
  state.qr = null;
  state.error = null;
  broadcast();
  if (current) {
    try {
      await current.destroy();
    } catch {
      /* the session is going away either way */
    }
  }
}

function listContacts() {
  return client.getContacts().then((contacts) => {
    const unique = new Map();
    for (const contact of contacts) {
      if (!contact.isMyContact || contact.isMe || contact.isGroup || contact.isBlocked) continue;
      if (!contactId.isPersonId(contact.id?._serialized)) continue;
      const phone = contactId.userPartOf(contact.number || contact.id?.user);
      const name = String(contact.name || contact.pushname || '').trim();
      // Service accounts, short codes and broadcast ids are not people.
      if (!name || phone.length < 8 || phone.length > 15) continue;
      const key = contactId.looseKey(phone) || phone;
      if (unique.has(key)) continue;
      unique.set(key, { waId: contact.id._serialized, phone, name });
    }
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
}

function requireReady() {
  if (!client || state.connection !== 'ready') throw new Error('WhatsApp is not connected.');
}

/* -------------------------------------------------------------------- window */

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

// whatsapp-web.js rejects from inside its own promise chains during session
// handover. Without these the app looked healthy while the session was already
// gone, and the reason only existed in a terminal nobody reads.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  fail(error.message);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 820,
    minHeight: 620,
    title: 'Desvio',
    show: false,
    backgroundColor: '#000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // The interface is local. Anything trying to navigate it elsewhere is a bug or
  // an attack, and either way it opens outside instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  // A renderer error used to leave a black window and no explanation anywhere.
  mainWindow.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${source}:${line} ${message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) =>
    console.error('[renderer] gone:', details.reason)
  );
  if (process.env.DESVIO_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  // DESVIO_SHOT=<file> renders one frame and quits. Capturing from inside the app
  // needs no screen-recording permission, which is what makes site and store
  // screenshots reproducible instead of hand-taken.
  if (process.env.DESVIO_DEMO) {
    mainWindow.webContents.once('did-finish-load', () => {
      injectDemoMessage(process.env.DESVIO_DEMO).catch((error) => fail(error.message));
    });
  }
  if (process.env.DESVIO_SHOT) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.DESVIO_SHOT_DELAY) || 1500)
      );
      if (process.env.DESVIO_SHOT_SCROLL) {
        await mainWindow.webContents.executeJavaScript(
          `window.scrollTo(0, ${Number(process.env.DESVIO_SHOT_SCROLL) || 0})`
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(process.env.DESVIO_SHOT, image.toPNG());
      app.quit();
    });
  }
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function openMediaWindow(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('That link is not valid.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web links can be opened.');
  const viewer = new BrowserWindow({
    width: 980,
    height: 780,
    title: 'Desvio',
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Its own session, so a login on Instagram or TikTok survives without ever
      // touching the rest of the app.
      partition: 'persist:desvio-viewer'
    }
  });
  viewer.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) viewer.loadURL(target);
    return { action: 'deny' };
  });
  return viewer.loadURL(url.toString());
}

app.whenReady().then(() => {
  storePath = path.join(app.getPath('userData'), 'settings.json');
  mediaDir = path.join(app.getPath('userData'), 'media');
  state.settings = readStore();
  fs.mkdirSync(mediaDir, { recursive: true });

  protocol.handle(MEDIA_SCHEME, (request) => {
    const name = path.basename(new URL(request.url).pathname);
    const file = path.join(mediaDir, name);
    if (!file.startsWith(mediaDir)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  createWindow();
  refreshGroqModels();
  if (process.env.DESVIO_PROBE) connectWhatsApp();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  if (storeTimer) writeStore();
  client?.destroy().catch(() => {});
});

/* ----------------------------------------------------------------------- ipc */

function handle(channel, listener) {
  ipcMain.handle(channel, async (_event, payload) => listener(payload));
}

handle('state:get', () => publicState());

handle('settings:save', (incoming) => {
  const settings = incoming || {};
  state.settings = {
    ...state.settings,
    language: settings.language ?? state.settings.language,
    theme: settings.theme ?? state.settings.theme,
    model: String(settings.model || state.settings.model).trim(),
    defaultStyle: settings.defaultStyle ?? state.settings.defaultStyle,
    watchEveryone: settings.watchEveryone ?? state.settings.watchEveryone,
    contacts: Array.isArray(settings.contacts) ? settings.contacts : state.settings.contacts,
    // The renderer never receives these, so an absent value means "keep", not "clear".
    groqApiKey: settings.groqApiKey || state.settings.groqApiKey,
    learning: { ...state.settings.learning, ...(settings.learning || {}) },
    webhook: {
      ...state.settings.webhook,
      ...(settings.webhook || {}),
      token: settings.webhook?.token || state.settings.webhook.token
    }
  };
  writeStore();
  broadcast();
  if (settings.groqApiKey) refreshGroqModels();
  return publicState();
});

handle('groq:models', async () => {
  await refreshGroqModels();
  return publicState();
});

handle('error:clear', () => {
  state.error = null;
  broadcast();
  return publicState();
});

handle('whatsapp:connect', () => connectWhatsApp());
handle('whatsapp:disconnect', () => disconnectWhatsApp());
handle('whatsapp:contacts', () => {
  requireReady();
  return listContacts();
});

handle('learning:import', async () => {
  await importWritingHistory();
  return publicState();
});

handle('learning:forget', () => {
  state.settings.writingSamples = [];
  writeStore();
  broadcast();
  return publicState();
});

handle('media:load', ({ id }) => {
  requireReady();
  return cacheMedia(id);
});

handle('media:open', ({ url }) => openMediaWindow(url));

handle('reply:decide', async ({ id, action, reply }) => {
  const item = state.pending.find((entry) => entry.id === id);
  if (!item) return publicState();
  if (action === 'send') {
    requireReady();
    await sendAndConfirm(item.contactId, signature.sign(reply));
  }
  state.pending = state.pending.filter((entry) => entry.id !== id);
  broadcast();
  return publicState();
});

function enabledContact(id) {
  const contact = state.settings.contacts.find(
    (candidate) =>
      candidate.id === id && candidate.enabled !== false && candidate.mode !== 'disabled'
  );
  if (!contact) throw new Error('Pick someone who is enabled on your list.');
  return contact;
}

handle('direct:draft', ({ id, instruction }) => draftForOwner(enabledContact(id), instruction));

handle('direct:send', async ({ id, reply }) => {
  const contact = enabledContact(id);
  requireReady();
  await sendAndConfirm(await resolveChatId(contact), signature.sign(reply));
  return true;
});

handle('text:inspect', ({ text }) => fingerprint.inspect(text));
