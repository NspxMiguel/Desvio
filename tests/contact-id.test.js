const { test, expect, describe } = require('bun:test');
const contactId = require('../src/core/contact-id.cjs');

describe('normalisation', () => {
  test('keeps only the user part of a WhatsApp id', () => {
    expect(contactId.userPartOf('5511987654321@c.us')).toBe('5511987654321');
    expect(contactId.userPartOf('+55 (11) 98765-4321')).toBe('5511987654321');
    expect(contactId.userPartOf('')).toBe('');
  });

  test('builds a WhatsApp id from a typed number', () => {
    expect(contactId.toWhatsAppId('+55 11 98765-4321')).toBe('5511987654321@c.us');
    expect(contactId.toWhatsAppId('')).toBe('');
  });

  test('accepts people, rejects groups, channels and broadcasts', () => {
    expect(contactId.isPersonId('5511987654321@c.us')).toBe(true);
    expect(contactId.isPersonId('123456789@lid')).toBe(true);
    expect(contactId.isPersonId('120363000000000000@g.us')).toBe(false);
    expect(contactId.isPersonId('status@broadcast')).toBe(false);
    expect(contactId.isPersonId('0000@newsletter')).toBe(false);
  });
});

describe('matching a person across the forms WhatsApp uses', () => {
  test("Brazil's ninth digit is optional", () => {
    expect(contactId.sameContact('5511987654321', '551187654321')).toBe(true);
    expect(contactId.sameContact('551187654321@c.us', '5511987654321@c.us')).toBe(true);
  });

  test('Mexico and Argentina trunk digits behave the same way', () => {
    expect(contactId.sameContact('5215512345678', '525512345678')).toBe(true);
    expect(contactId.sameContact('5491112345678', '541112345678')).toBe(true);
  });

  test('different people never match', () => {
    expect(contactId.sameContact('5511987654321', '5511912345678')).toBe(false);
    expect(contactId.sameContact('5511987654321', '5521987654321')).toBe(false);
    expect(contactId.sameContact('', '5511987654321')).toBe(false);
  });

  test('a stored contact matches by its WhatsApp id or by its number', () => {
    const contact = { waId: '551187654321@c.us', phone: '5511987654321', name: 'Ana' };
    expect(contactId.matchesContact(contact, '551187654321@c.us')).toBe(true);
    expect(contactId.matchesContact(contact, '5511987654321@c.us')).toBe(true);
    expect(contactId.matchesContact(contact, '5511999999999@c.us')).toBe(false);
    expect(contactId.matchesContact(null, '551187654321@c.us')).toBe(false);
  });

  test('the allow-list finds the right person', () => {
    const contacts = [
      { id: 'a', phone: '5511911111111', name: 'Ana' },
      { id: 'b', phone: '5511922222222', name: 'Bruno' }
    ];
    expect(contactId.findContact(contacts, '551122222222@c.us')?.id).toBe('b');
    expect(contactId.findContact(contacts, '5511933333333@c.us')).toBeUndefined();
  });

  test('a short number never collides through the loose key', () => {
    expect(contactId.looseKey('5511')).toBeNull();
    expect(contactId.sameContact('5511', '5512')).toBe(false);
  });
});
