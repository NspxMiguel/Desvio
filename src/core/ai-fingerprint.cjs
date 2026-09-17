'use strict';

const signature = require('./signature.cjs');

// Nothing here proves a message was written by a machine, and the app never claims
// it does. What it produces is a suspicion score with the reasons attached, so the
// owner can look at the evidence and decide. The only certain signal is Desvio's
// own marker, because Desvio is what put it there.

// Zero-width and invisible characters. Several assistants and the copy buttons of
// "invisible character" sites leave these behind; a person typing on a phone
// keyboard does not produce them.
const INVISIBLE = /[​-‏⁠-⁤‪-‮﻿­᠎ㅤﾠ]/gu;

const EM_DASH = /[—–]/gu;
const CURLY_QUOTES = /[“”‘’]/gu;
const ELLIPSIS = /…/gu;
const BULLET_LINE = /^\s*(?:[-*•–—]|\d+[.)])\s+\S/gmu;

// The way people actually type on WhatsApp: laughter, abbreviations, emoji,
// stacked punctuation. Prose with none of it, at length, is the tell.
const CHAT_MARKERS =
  /(?:k{3,}|haha|hehe|rs{2,}|lol|lmao|\bhm+\b|\bvc\b|\bpq\b|\btbm\b|\btb\b|\bmsm\b|\bqnd\b|\bdps\b|\bvlw\b|\bflw\b|\bblz\b|\bmt\b|\bpra\b|\bta\b|\bto\b|\bné\b|\bkk\b|\bu\b|\bur\b|\brn\b|\btbh\b|\bidk\b|\bomg\b|\bbtw\b|\bgonna\b|\bwanna\b|\byeah\b|\bnah\b|[!?]{2,})/iu;

const EMOJI = /\p{Extended_Pictographic}/u;

// "não é X, é Y" and its English twin, a cadence chat assistants fall into.
const CONTRAST_CLICHE =
  /(?:n[aã]o\s+[ée]\s+[^,.!?]{2,45},\s*[ée]\s)|(?:isn'?t\s+(?:just\s+)?[^,.!?]{2,45},\s*it'?s\s)|(?:mais\s+do\s+que\s+[^,.!?]{2,45},\s*[ée]\s)/iu;

// Customer-service voice: nobody texts a friend like this.
const ASSISTANT_VOICE =
  /(?:posso\s+ajudar|fico\s+[aà]\s+disposi[cç][aã]o|espero\s+ter\s+ajudado|qualquer\s+d[uú]vida,?\s+estou|happy\s+to\s+help|let\s+me\s+know\s+if\s+you|feel\s+free\s+to|i'?m\s+here\s+to\s+help|as\s+an\s+ai)/iu;

const LEVELS = [
  { level: 'certain', from: 100 },
  { level: 'high', from: 80 },
  { level: 'medium', from: 55 },
  { level: 'low', from: 30 },
  { level: 'none', from: 0 }
];

const HEURISTIC_CEILING = 92;

function levelFor(score) {
  return LEVELS.find((entry) => score >= entry.from).level;
}

function countOf(text, pattern) {
  return (text.match(pattern) || []).length;
}

function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function looksPolished(text) {
  const parts = sentences(text);
  if (parts.length < 2) return false;
  const properlyOpened = parts.every((part) => {
    const first = part.match(/\p{L}/u);
    return !first || first[0] === first[0].toLocaleUpperCase();
  });
  const properlyClosed = /[.!?]$/u.test(text.trim());
  return properlyOpened && properlyClosed;
}

/**
 * Score how much a message reads as machine-written.
 * @param {string} text raw message body, exactly as received
 * @returns {{score: number, level: string, signals: Array<{id: string, weight: number}>}}
 */
function inspect(text) {
  const raw = String(text ?? '');
  if (signature.isSigned(raw)) {
    return { score: 100, level: 'certain', signals: [{ id: 'desvioMarker', weight: 100 }] };
  }

  const body = raw.trim();
  if (!body) return { score: 0, level: 'none', signals: [] };

  const signals = [];
  const add = (id, weight) => signals.push({ id, weight });

  const invisible = countOf(raw, INVISIBLE);
  if (invisible > 0) add('invisibleCharacters', 55);

  const dashes = countOf(body, EM_DASH);
  if (dashes >= 2) add('emDash', 22);
  else if (dashes === 1 && body.length >= 60) add('emDash', 14);

  if (countOf(body, CURLY_QUOTES) >= 2) add('curlyQuotes', 12);
  if (countOf(body, ELLIPSIS) >= 1) add('typographicEllipsis', 8);
  if (countOf(body, BULLET_LINE) >= 2) add('bulletList', 18);
  if (ASSISTANT_VOICE.test(body)) add('assistantVoice', 30);
  if (CONTRAST_CLICHE.test(body)) add('contrastCliche', 12);

  const casual = CHAT_MARKERS.test(body) || EMOJI.test(body);
  if (body.length >= 180 && looksPolished(body) && !casual) add('polishedProse', 18);
  if (body.length >= 120 && !casual) add('noChatMarkers', 10);

  const score = Math.min(
    HEURISTIC_CEILING,
    signals.reduce((total, entry) => total + entry.weight, 0)
  );
  return { score, level: levelFor(score), signals };
}

/**
 * Fold a language model's own guess into the local reading. The local signals win
 * when they are strong, because an invisible character is evidence and a model
 * opinion is an opinion.
 */
function blend(local, modelLikelihood) {
  if (local.level === 'certain') return local;
  const model = Number(modelLikelihood);
  if (!Number.isFinite(model) || model <= 0) return local;
  const scaled = Math.round(Math.min(100, Math.max(0, model)) * 0.85);
  if (scaled <= local.score) return local;
  const score = Math.min(HEURISTIC_CEILING, scaled);
  return {
    score,
    level: levelFor(score),
    signals: [...local.signals, { id: 'modelOpinion', weight: score - local.score }]
  };
}

// Above this, a message is treated as machine-written and never becomes an
// example of how the owner writes. Learning from text another assistant wrote for
// him would teach this app to imitate a chatbot imitating him.
const SAMPLE_THRESHOLD = 55;

/**
 * Should this outgoing message become one of the owner's writing samples?
 * @param {string} text the message exactly as it was sent
 */
function worthLearningFrom(text) {
  const body = String(text ?? '').trim();
  if (!body) return false;
  return inspect(body).score < SAMPLE_THRESHOLD;
}

module.exports = { inspect, blend, levelFor, worthLearningFrom, SAMPLE_THRESHOLD, INVISIBLE };
