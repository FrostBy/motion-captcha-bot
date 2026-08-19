import { describe, expect, it } from 'vitest';

import {
  HEIGHT,
  WIDTH,
  buildMask,
  makeDecoy,
  makeExpression,
  renderFrames,
  type Motion,
  type Style,
} from './captcha.js';
import { textMask } from './font.js';

/** Mean brightness of a frame region selected by mask (1 is glyph, 0 is rest). */
function meanBy(frame: Uint8Array, mask: Uint8Array, inside: boolean): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < frame.length; i++) {
    if (Boolean(mask[i]) !== inside) continue;
    sum += frame[i]!;
    count++;
  }
  return sum / count;
}

function averaged(frames: Uint8Array[]): Uint8Array {
  const acc = new Float64Array(WIDTH * HEIGHT);
  for (const frame of frames) for (let i = 0; i < acc.length; i++) acc[i] = acc[i]! + frame[i]!;
  return Uint8Array.from(acc, (v) => v / frames.length);
}

describe('expression', () => {
  it('single-digit operands, answer is the sum', () => {
    for (let i = 0; i < 50; i++) {
      const { question, answer } = makeExpression();
      const [n, m] = question.split('+').map(Number);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(9);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(9);
      expect(n! + m!).toBe(answer);
    }
  });

  it('decoy sum never matches the real answer', () => {
    for (let i = 0; i < 50; i++) {
      const real = makeExpression();
      expect(makeDecoy(real.answer).answer).not.toBe(real.answer);
    }
  });
});

describe('text mask', () => {
  it('rasterizes glyphs, throws on an unknown character', () => {
    const { mask, width, height } = textMask('12+34', 2);
    expect(width).toBe((5 * 6 - 1) * 2);
    expect(height).toBe(14);
    expect(mask.some((v) => v === 1)).toBe(true);
    expect(() => textMask('a', 2)).toThrow('No glyph');
  });
});

// Sparse dots flip a smaller share of glyph pixels than dense bands do.
const CASES: Array<{ style: Style; motion: Motion; minDrift: number }> = [
  { style: 'l', motion: 1, minDrift: 0.2 },
  { style: 'l', motion: 2, minDrift: 0.2 },
  { style: 'g', motion: 1, minDrift: 0.2 },
  { style: 'g', motion: 2, minDrift: 0.2 },
  { style: 'dots', motion: 1, minDrift: 0.05 },
  { style: 'dots', motion: 2, minDrift: 0.05 },
];

describe.each(CASES)('still-frame blindness: $style, motion $motion', ({ style, motion, minDrift }) => {
  const { frames, mask } = renderFrames('4+2', { style, motion });

  it('frames come out sized', () => {
    expect(frames.length).toBeGreaterThanOrEqual(60);
    expect(frames[0]!.length).toBe(WIDTH * HEIGHT);
    expect(mask.some((v) => v === 1)).toBe(true);
  });

  it('single frame: glyph and background are statistically alike', () => {
    // A screenshot is useless: region means differ by less than 4%.
    const inside = meanBy(frames[0]!, mask, true);
    const outside = meanBy(frames[0]!, mask, false);
    expect(Math.abs(inside - outside)).toBeLessThan(255 * 0.04);
  });

  it('frame averaging (pixel delay map) is blind too', () => {
    const mean = averaged(frames);
    const inside = meanBy(mean, mask, true);
    const outside = meanBy(mean, mask, false);
    expect(Math.abs(inside - outside)).toBeLessThan(255 * 0.04);
  });

  it('glyph noise actually drifts (the signal exists)', () => {
    // Otherwise no human could solve it: adjacent frames differ inside the mask.
    let changed = 0;
    let total = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      total++;
      if (frames[0]![i] !== frames[1]![i]) changed++;
    }
    expect(changed / total).toBeGreaterThan(minDrift);
  });
});

describe('decoy', () => {
  it('averaging reveals the fake, not the real answer', () => {
    const { frames } = renderFrames('4+2', { style: 'l', decoyQuestion: '9+9' });
    const decoyMask = buildMask('9+9');
    const mean = averaged(frames);
    // The decoy region is consistently darker than the rest of the field.
    const inside = meanBy(mean, decoyMask, true);
    const outside = meanBy(mean, decoyMask, false);
    expect(outside - inside).toBeGreaterThan(4);
  });
});
