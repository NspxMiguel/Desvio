'use strict';

// The rolling sample list forgets: it keeps the last N messages and drops the
// rest. Slang needs the opposite — something that only accumulates.
//
// Counting frequent words does not work: the most frequent words in anyone's
// messages are "de", "na", "pra", plus whatever a single conversation happened to
// be about. The signal that separates how he talks from what he talked about is
// spread — a word he uses with many different people is a habit; a word that only
// ever appears with one person is that conversation's subject.

const TOKEN = /[\p{L}\p{N}']{1,20}/gu;

// Function words and fillers: frequent everywhere, meaningless as style.
const COMMON = new Set(
  `a as o os um uma uns umas de do da dos das em no na nos nas por pra para pelo pela com sem
   e ou mas que se ao aos à às já ainda só apenas muito mais menos tão também tem ter tinha
   ser sou é foi era vai vou vamos fazer faz fez ficar fica está estou estava esse essa isso
   este esta isto aquele aquela aquilo meu minha seu sua nosso nossa dele dela eles elas
   eu tu você ele ela nós lá aqui ali onde quando como porque quem qual quais entao então
   sobre depois antes agora hoje amanha amanhã ontem coisa coisas gente pessoa vez vezes
   the a an and or but if of in on at to for with from this that these those is are was were
   be been being have has had do does did will would can could should i you he she it we they
   my your his her its our their there here what when where why how all any some not no yes
   https http www com br net org`
    .split(/\s+/)
    .filter(Boolean)
);

// Written shorthand is slang even when it appears with one person only: nobody
// types this way by accident.
const SHORTHAND =
  /^(?:vc|vcs|pq|pqp|tb|tbm|msm|qnd|qdo|dps|vlw|flw|blz|mt|mto|cmg|ctg|kd|tmj|slk|slc|mds|kkk|haha|rsrs|hehe|eae|eai|opa|mano|veio|véi|cara|bicho|porra|caralho|krl|foda|rolê|role|bora|top|sla|neh|né|to|ta|ne)$/i;

function normalise(token) {
  if (/^k{2,}$/.test(token)) return 'kkk';
  if (/^(?:ha){2,}$/.test(token)) return 'haha';
  if (/^(?:rs){2,}$/.test(token)) return 'rsrs';
  if (/^(?:he){2,}$/.test(token)) return 'hehe';
  return token;
}

function termsOf(text) {
  const found = String(text ?? '')
    .toLowerCase()
    .match(TOKEN);
  if (!found) return [];
  const kept = [];
  for (const raw of found) {
    const token = normalise(raw);
    if (COMMON.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (SHORTHAND.test(token) || token.length >= 4) kept.push(token);
  }
  return kept;
}

/**
 * Fold one message into the running counts for one person.
 */
function remember(counts, text) {
  const next = { ...counts };
  for (const term of termsOf(text)) {
    next[term] = (next[term] || 0) + 1;
  }
  return next;
}

/**
 * The words that sound like him rather than like a subject he once discussed.
 * @param {Record<string, Record<string, number>>} glossary counts keyed by contact
 * @param {string} contactKey whose conversation to favour
 */
function habits(glossary, contactKey, limit = 25) {
  const buckets = Object.entries(glossary || {}).filter(([key]) => key !== '*');
  const spread = new Map();
  for (const [, counts] of buckets) {
    for (const term of Object.keys(counts || {})) {
      spread.set(term, (spread.get(term) || 0) + 1);
    }
  }

  const score = (term, count) => (spread.get(term) || 0) * 10 + Math.min(count, 20);
  const eligible = (term, count) =>
    count >= 2 && (SHORTHAND.test(term) || (spread.get(term) || 0) >= 2);

  const rank = (counts) =>
    Object.entries(counts || {})
      .filter(([term, count]) => eligible(term, count))
      .sort((a, b) => score(b[0], b[1]) - score(a[0], a[1]) || a[0].localeCompare(b[0]))
      .map(([term]) => term);

  const withPerson = rank((glossary || {})[contactKey]);
  const overall = rank((glossary || {})['*']).filter((term) => !withPerson.includes(term));
  return [...withPerson, ...overall].slice(0, limit);
}

module.exports = { remember, habits, termsOf, normalise, SHORTHAND };
