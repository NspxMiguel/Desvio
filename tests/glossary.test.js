const { test, expect, describe } = require('bun:test');
const glossary = require('../src/core/glossary.cjs');

describe('remembering how he writes', () => {
  test('keeps his words and drops the ones everybody uses', () => {
    const terms = glossary.termsOf('mano vc vai no rolê que nao é longe');
    expect(terms).toContain('mano');
    expect(terms).toContain('rolê');
    expect(terms).not.toContain('que');
    expect(terms).not.toContain('não');
  });

  test('laughter is one word, not a hundred', () => {
    expect(glossary.normalise('kkkkkkk')).toBe('kkk');
    expect(glossary.normalise('hahaha')).toBe('haha');
    expect(glossary.normalise('rsrsrs')).toBe('rsrs');
  });

  test('counts only grow, message after message', () => {
    let counts = {};
    counts = glossary.remember(counts, 'mano bora');
    counts = glossary.remember(counts, 'mano, bora sim kkkk');
    expect(counts.mano).toBe(2);
    expect(counts.bora).toBe(2);
    expect(counts.kkk).toBe(1);
  });

  test('function words and bare numbers never count', () => {
    const terms = glossary.termsOf('de na pra só 42 onde');
    expect(terms).toEqual([]);
  });
});

describe('telling a habit from a subject', () => {
  // The same word used with three people is how he talks; a word that only ever
  // appears in one conversation is what that conversation was about.
  const build = () => {
    const words = {};
    const add = (key, text) => {
      words[key] = glossary.remember(words[key], text);
      words['*'] = glossary.remember(words['*'], text);
    };
    for (const person of ['111', '222', '333']) {
      add(person, 'mano bora nesse rolê');
      add(person, 'mano bora sim');
    }
    add('111', 'a folha das letras e das cores');
    add('111', 'folha das letras, cores certas');
    add('111', 'folha folha letras cores');
    return words;
  };

  test('what he says to everyone wins over one chat subject', () => {
    const top = glossary.habits(build(), '111', 10);
    expect(top).toContain('mano');
    expect(top).toContain('bora');
    expect(top.indexOf('mano')).toBeLessThan(
      top.indexOf('folha') === -1 ? 99 : top.indexOf('folha')
    );
  });

  test('a subject stuck to a single conversation is dropped', () => {
    const top = glossary.habits(build(), '111', 10);
    expect(top).not.toContain('folha');
    expect(top).not.toContain('cores');
  });

  test('shorthand counts even with one person only', () => {
    const words = { 111: glossary.remember(glossary.remember({}, 'vlw'), 'vlw mesmo') };
    expect(glossary.habits(words, '111', 10)).toContain('vlw');
  });
});
