/** 5x7 bitmap font, just enough for an "N+M" expression. */
const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;

/**
 * Text mask: ones where the glyph is, a spacer column between characters.
 * Integer scale, blocky edges, good enough for moving noise.
 */
export function textMask(
  text: string,
  scale: number,
): { mask: Uint8Array; width: number; height: number } {
  const cols = text.length * (GLYPH_W + 1) - 1;
  const width = cols * scale;
  const height = GLYPH_H * scale;
  const mask = new Uint8Array(width * height);

  for (let c = 0; c < text.length; c++) {
    const glyph = GLYPHS[text[c]!];
    if (!glyph) throw new Error(`No glyph for "${text[c]}"`);
    const originX = c * (GLYPH_W + 1) * scale;
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (glyph[gy]![gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          const y = gy * scale + sy;
          const rowStart = y * width + originX + gx * scale;
          mask.fill(1, rowStart, rowStart + scale);
        }
      }
    }
  }
  return { mask, width, height };
}
