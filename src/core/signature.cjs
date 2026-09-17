'use strict';

// Every message Desvio writes ends with two Hangul Filler characters (U+3164).
// They render as blank space in WhatsApp but are ordinary letters to Unicode, so
// trimEnd() never eats them and the owner can always tell his own writing apart
// from the assistant's. Anything carrying this marker is excluded from learning.
const MARKER_CHARACTER = 'ㅤ';
const MARKER = MARKER_CHARACTER.repeat(2);

function strip(text) {
  return String(text ?? '').replace(new RegExp(`${MARKER_CHARACTER}+`, 'g'), '');
}

function isSigned(text) {
  return String(text ?? '').includes(MARKER);
}

function sign(text) {
  return `${strip(text).trimEnd()}${MARKER}`;
}

module.exports = { MARKER, MARKER_CHARACTER, sign, strip, isSigned };
