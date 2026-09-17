'use strict';

// WhatsApp does not hand back the same string the phone book holds. A Brazilian
// mobile is stored as 55 + area + 9 + 8 digits in contacts, while WhatsApp keeps
// the pre-2012 form without that extra 9 for accounts registered long ago, and
// newer builds address some chats as @lid instead of @c.us. Matching a contact by
// a single literal id therefore fails silently: the allow-list looks correct and
// the assistant simply never answers. Everything here exists to make that match
// survive those variations.

const PERSON_SERVERS = ['c.us', 'lid'];

function digitsOf(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function userPartOf(value) {
  const text = String(value ?? '').trim();
  const at = text.indexOf('@');
  return digitsOf(at === -1 ? text : text.slice(0, at));
}

function toWhatsAppId(value) {
  const user = userPartOf(value);
  return user ? `${user}@c.us` : '';
}

// National trunk digits that some carriers add or drop between the phone book
// and the WhatsApp account: Brazil's ninth digit, Mexico's 1, Argentina's 9.
function numberVariants(value) {
  const digits = userPartOf(value);
  const variants = new Set();
  if (!digits) return variants;
  variants.add(digits);

  if (digits.startsWith('55') && digits.length === 13 && digits[4] === '9') {
    variants.add(digits.slice(0, 4) + digits.slice(5));
  }
  if (digits.startsWith('55') && digits.length === 12) {
    variants.add(`${digits.slice(0, 4)}9${digits.slice(4)}`);
  }
  if (digits.startsWith('52') && digits.length === 13 && digits[2] === '1') {
    variants.add(`52${digits.slice(3)}`);
  }
  if (digits.startsWith('52') && digits.length === 12) {
    variants.add(`521${digits.slice(2)}`);
  }
  if (digits.startsWith('54') && digits.length === 13 && digits[2] === '9') {
    variants.add(`54${digits.slice(3)}`);
  }
  if (digits.startsWith('54') && digits.length === 12) {
    variants.add(`549${digits.slice(2)}`);
  }
  return variants;
}

// Safety net for the trunk-digit rules above: same country and area code plus the
// same final eight digits is the same person in practice, and narrow enough that
// two different people cannot collide.
function looseKey(value) {
  const digits = userPartOf(value);
  if (digits.length < 10) return null;
  return `${digits.slice(0, 4)}:${digits.slice(-8)}`;
}

function isPersonId(value) {
  const text = String(value ?? '');
  const at = text.indexOf('@');
  if (at === -1) return Boolean(userPartOf(text));
  return PERSON_SERVERS.includes(text.slice(at + 1));
}

function sameContact(a, b) {
  const left = numberVariants(a);
  const right = numberVariants(b);
  if (!left.size || !right.size) return false;
  for (const candidate of left) {
    if (right.has(candidate)) return true;
  }
  const leftLoose = looseKey(a);
  return Boolean(leftLoose) && leftLoose === looseKey(b);
}

// A stored contact may carry the serialized WhatsApp id it was picked from plus a
// plain phone number; an incoming message matches if either one lines up.
function matchesContact(contact, whatsappId) {
  if (!contact) return false;
  return [contact.waId, contact.phone].some(
    (candidate) => candidate && sameContact(candidate, whatsappId)
  );
}

function findContact(contacts, whatsappId) {
  return (contacts || []).find((contact) => matchesContact(contact, whatsappId));
}

function displayNumber(value) {
  const digits = userPartOf(value);
  return digits ? `+${digits}` : '';
}

module.exports = {
  digitsOf,
  userPartOf,
  toWhatsAppId,
  numberVariants,
  looseKey,
  isPersonId,
  sameContact,
  matchesContact,
  findContact,
  displayNumber
};
