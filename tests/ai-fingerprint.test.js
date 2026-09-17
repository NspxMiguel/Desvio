const { test, expect, describe } = require('bun:test');
const fingerprint = require('../src/core/ai-fingerprint.cjs');
const signature = require('../src/core/signature.cjs');

describe('the invisible marker', () => {
  test('survives trimming and signs only once', () => {
    const signed = signature.sign('bom dia  ');
    expect(signed).toBe(`bom dia${signature.MARKER}`);
    expect(signature.sign(signed)).toBe(signed);
    expect(signature.isSigned(signed)).toBe(true);
    expect(signature.strip(signed)).toBe('bom dia');
  });

  test('plain writing is never mistaken for signed', () => {
    expect(signature.isSigned('bom dia')).toBe(false);
    expect(signature.isSigned('')).toBe(false);
  });
});

describe('scoring a message', () => {
  test("Desvio's own marker is the only certainty", () => {
    const result = fingerprint.inspect(signature.sign('chego em 10'));
    expect(result.level).toBe('certain');
    expect(result.score).toBe(100);
    expect(result.signals[0].id).toBe('desvioMarker');
  });

  test('how he actually types raises no suspicion', () => {
    expect(fingerprint.inspect('eae mano, blz? kkkk').level).toBe('none');
    expect(fingerprint.inspect('ok').level).toBe('none');
    expect(fingerprint.inspect('').score).toBe(0);
  });

  test('a zero-width character is a strong signal on its own', () => {
    const result = fingerprint.inspect('tudo certo por aqui​');
    expect(result.score).toBeGreaterThanOrEqual(55);
    expect(result.signals.some((signal) => signal.id === 'invisibleCharacters')).toBe(true);
  });

  test('assistant voice and polished prose stack up', () => {
    const text =
      'Olá! Espero que esteja tudo bem com você. Gostaria de informar que o prazo foi ' +
      'estendido até a próxima semana. Caso precise de qualquer coisa, fico à disposição ' +
      'para ajudar no que for necessário. Tenha um excelente dia.';
    const result = fingerprint.inspect(text);
    expect(['medium', 'high']).toContain(result.level);
    expect(result.signals.some((signal) => signal.id === 'assistantVoice')).toBe(true);
  });

  test('em dashes and bullet lists are chat-unnatural', () => {
    const result = fingerprint.inspect('Resumo — pontos principais:\n- um item\n- outro item');
    expect(result.signals.map((signal) => signal.id)).toContain('bulletList');
    expect(result.score).toBeGreaterThan(0);
  });

  test('the heuristics never reach certainty on their own', () => {
    const text = '— '.repeat(30) + 'Isso não é apenas um texto, é uma demonstração. '.repeat(6);
    expect(fingerprint.inspect(text).score).toBeLessThan(100);
  });
});

describe('folding in the model opinion', () => {
  const casual = fingerprint.inspect('vamo marcar amanha entao');

  test('a confident model can raise a quiet local reading', () => {
    const blended = fingerprint.blend(casual, 90);
    expect(blended.score).toBeGreaterThan(casual.score);
    expect(blended.signals.some((signal) => signal.id === 'modelOpinion')).toBe(true);
  });

  test('a weak or missing opinion changes nothing', () => {
    expect(fingerprint.blend(casual, 0)).toEqual(casual);
    expect(fingerprint.blend(casual, undefined)).toEqual(casual);
    expect(fingerprint.blend(casual, NaN)).toEqual(casual);
  });

  test('evidence outranks opinion: the marker stays certain', () => {
    const certain = fingerprint.inspect(signature.sign('oi'));
    expect(fingerprint.blend(certain, 5)).toEqual(certain);
  });
});

describe('not accusing people who simply write properly', () => {
  test('a long, tidy, human message stays unbadged', () => {
    const text =
      'Bom dia, filho. Passei no mercado hoje cedo e comprei aquele pão que você gosta. ' +
      'Se quiser passar aqui no fim da tarde, eu deixo separado para você levar. ' +
      'Sua mãe mandou perguntar se você vem almoçar no domingo.';
    expect(text.length).toBeGreaterThan(180);
    expect(fingerprint.inspect(text).level).toBe('none');
  });
});

describe('deciding what to learn from', () => {
  test('his own writing becomes a sample', () => {
    expect(fingerprint.worthLearningFrom('eae, chego umas 8 entao')).toBe(true);
    expect(fingerprint.worthLearningFrom('bom dia! trouxe o pão que você pediu.')).toBe(true);
  });

  test('text another assistant wrote for him does not', () => {
    const pasted =
      'Olá! Espero que esteja tudo bem. Gostaria de informar que o prazo mudou — ' +
      'seguimos com a entrega na próxima semana. Qualquer dúvida, estou à disposição ' +
      'para ajudar no que for preciso. Tenha um ótimo dia.';
    expect(fingerprint.worthLearningFrom(pasted)).toBe(false);
  });

  test("Desvio's own replies never feed themselves", () => {
    expect(fingerprint.worthLearningFrom(signature.sign('chego em 10'))).toBe(false);
  });

  test('an empty message is not a sample', () => {
    expect(fingerprint.worthLearningFrom('   ')).toBe(false);
    expect(fingerprint.worthLearningFrom(null)).toBe(false);
  });
});
