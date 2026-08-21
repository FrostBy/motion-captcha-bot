import { spawn } from 'node:child_process';

import { GLYPH_W, textMask } from './font.js';

/**
 * "N+M" captcha readable only in motion: a still frame and per-pixel frame
 * averaging both yield flat noise, so OCR and multimodal models are blind
 * while humans read the digits through motion perception.
 *
 * Styles: 'l' and 'g' are binary-noise bands (2px/1px grain) sliding
 * vertically while the caption drifts along an ellipse; 'dots' is a sparse
 * field of subpixel dots (Ghost Font mechanics).
 *
 * Motion presets: 1 moves glyph and background in opposite directions;
 * 2 moves them in the same direction with different, sine-wobbling speeds,
 * which defeats shift-matching attacks (contrasting +shift vs -shift match
 * maps).
 *
 * Extra shields: `sprinkle` re-seeds a share of pixels with fresh noise
 * every frame (correlates with no layer, dirties match maps); `decoy` bakes
 * a faint static fake expression into the field, so frame averaging reveals
 * the fake instead of the answer, and replying with the fake sum instantly
 * exposes a bot.
 */

export const WIDTH = 320;
export const HEIGHT = 160;
export const FPS = 30;

export type Style = 'l' | 'g' | 'dots';
export type Motion = 1 | 2;

export interface RenderOptions {
  style?: Style;
  motion?: Motion;
  /** Share of pixels re-seeded with fresh noise each frame, 0..1. */
  sprinkle?: number;
  /** Fake expression baked in as a faint static layer. */
  decoyQuestion?: string;
  random?: () => number;
}

/** Bands: px per frame, dark-cell density, caption ellipse radius. */
const BAND_FRAMES = 90;
const BAND_SPEED = 2;
const BAND_DENSITY = 0.35;
const ORBIT = 14;
const BAND_DARK = 40;
const BAND_LIGHT = 215;

/** Motion 2: same-direction base speeds (px/frame) and sine wobble. */
const BAND_GLYPH_BASE = 2.2;
const BAND_GROUND_BASE = 1.1;
const BAND_WOBBLE = 6;
const DOT_GLYPH_BASE = 2.6;
const DOT_GROUND_BASE = 1.04;
const DOT_WOBBLE = 8;

/** Dots: jittered grid, subpixel size, opposing 0.52/-0.78·v speeds. */
const DOT_FRAMES = 120;
const DOT_SPEED = 60;
const GROUND_FACTOR = 0.52;
const GLYPH_FACTOR = -0.78;
const GRID_STEP = 4;
const JITTER = 0.8;
const DOT_MIN = 0.65;
const DOT_SPREAD = 0.9;
const ALPHA_MIN = 0.62;
const ALPHA_SPREAD = 0.36;
const PAPER = 238;
const INK = 18;

/**
 * Decoy darkening in gray levels: ~3% of the range, under the human eye's
 * threshold on a flickering field, yet plainly visible after averaging.
 */
const DECOY_SHIFT = 8;

const FFMPEG_TIMEOUT_MS = 60_000;

export interface Captcha {
  question: string;
  answer: number;
}

/** Small deterministic PRNG for repeatable integration tests. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Digits per operand. Single digits leave nineteen possible sums, so a few
 * guesses around 9 already carry a real chance; two digits widen the space to
 * about a hundred and eighty, at the price of a smaller glyph and arithmetic
 * a human has to think about.
 */
export type OperandDigits = 1 | 2;

export function makeExpression(
  random: () => number = Math.random,
  digits: OperandDigits = 1,
): Captcha {
  const min = digits === 2 ? 10 : 0;
  const span = digits === 2 ? 90 : 10;
  const n = min + Math.floor(random() * span);
  const m = min + Math.floor(random() * span);
  return { question: `${n}+${m}`, answer: n + m };
}

/** Fake expression whose sum never matches the real one. */
export function makeDecoy(
  realAnswer: number,
  random: () => number = Math.random,
  digits: OperandDigits = 1,
): Captcha {
  for (;;) {
    const decoy = makeExpression(random, digits);
    if (decoy.answer !== realAnswer) return decoy;
  }
}

function dilate(mask: Uint8Array, r: number): Uint8Array {
  if (r <= 0) return mask;
  const out = new Uint8Array(mask);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (!mask[y * WIDTH + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < HEIGHT && nx >= 0 && nx < WIDTH) out[ny * WIDTH + nx] = 1;
        }
      }
    }
  }
  return out;
}

export function buildMask(question: string): Uint8Array {
  const cols = question.length * (GLYPH_W + 1) - 1;
  const scale = Math.max(
    2,
    Math.min(Math.floor((WIDTH * 0.9) / cols), Math.floor((HEIGHT * 0.7) / 7)),
  );
  const glyphs = textMask(question, scale);
  const offsetX = Math.floor((WIDTH - glyphs.width) / 2);
  const offsetY = Math.floor((HEIGHT - glyphs.height) / 2);
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < glyphs.height; y++) {
    for (let x = 0; x < glyphs.width; x++) {
      if (glyphs.mask[y * glyphs.width + x]) mask[(y + offsetY) * WIDTH + (x + offsetX)] = 1;
    }
  }
  // Thicken strokes to ~1/4 of glyph height, thin digits drown in noise.
  return dilate(mask, Math.floor(scale / 3));
}

/** Same-direction drift with a sine wobble: no constant inter-frame shift. */
function drift(t: number, frames: number, base: number, wobble: number, phase: number): number {
  return base * t + wobble * Math.sin((2 * Math.PI * t * 2) / frames + phase);
}

function noiseCells(cols: number, rows: number, random: () => number): Uint8Array {
  const out = new Uint8Array(cols * rows);
  for (let i = 0; i < out.length; i++) out[i] = random() < BAND_DENSITY ? BAND_DARK : BAND_LIGHT;
  return out;
}

/** Two noise bands slide vertically; the caption drifts along an ellipse. */
function renderBands(
  mask: Uint8Array,
  grain: 1 | 2,
  motion: Motion,
  random: () => number,
): Uint8Array[] {
  const span = HEIGHT + Math.ceil(BAND_FRAMES * Math.max(BAND_SPEED, BAND_GLYPH_BASE + 0.2));
  const cols = Math.ceil(WIDTH / grain);
  const rows = Math.ceil(span / grain);
  const glyphCells = noiseCells(cols, rows, random);
  const groundCells = noiseCells(cols, rows, random);

  const frames: Uint8Array[] = [];
  for (let t = 0; t < BAND_FRAMES; t++) {
    const frame = new Uint8Array(WIDTH * HEIGHT);
    const gShift =
      motion === 1
        ? t * BAND_SPEED
        : Math.round(drift(t, BAND_FRAMES, BAND_GLYPH_BASE, BAND_WOBBLE, 0));
    const bShift =
      motion === 1
        ? (BAND_FRAMES - t) * BAND_SPEED
        : Math.round(drift(t, BAND_FRAMES, BAND_GROUND_BASE, BAND_WOBBLE, Math.PI));
    const phase = (2 * Math.PI * t) / BAND_FRAMES;
    const mx = Math.round(ORBIT * Math.cos(phase));
    const my = Math.round((ORBIT / 2) * Math.sin(phase));
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const col = Math.floor(x / grain);
        const sx = x - mx;
        const sy = y - my;
        const inGlyph =
          sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT
            ? Boolean(mask[sy * WIDTH + sx])
            : false;
        const shift = inGlyph ? gShift : bShift;
        const cells = inGlyph ? glyphCells : groundCells;
        const row = ((Math.floor((y + shift) / grain) % rows) + rows) % rows;
        frame[y * WIDTH + x] = cells[row * cols + col]!;
      }
    }
    frames.push(frame);
  }
  return frames;
}

interface Dot {
  x: number;
  y: number;
  size: number;
  alpha: number;
}

function makeDots(random: () => number): Dot[] {
  const dots: Dot[] = [];
  for (let y = GRID_STEP / 2; y < HEIGHT; y += GRID_STEP) {
    for (let x = GRID_STEP / 2; x < WIDTH; x += GRID_STEP) {
      dots.push({
        x: x + (random() - 0.5) * GRID_STEP * JITTER,
        y: y + (random() - 0.5) * GRID_STEP * JITTER,
        size: DOT_MIN + random() * DOT_SPREAD,
        alpha: ALPHA_MIN + random() * ALPHA_SPREAD,
      });
    }
  }
  return dots;
}

/** Subpixel dot: each pixel darkens by its overlap share (anti-aliasing). */
function stampAA(frame: Uint8Array, dot: Dot, atY: number): void {
  const y1 = atY + dot.size;
  const x0 = dot.x;
  const x1 = dot.x + dot.size;
  for (let px = Math.floor(x0); px < x1; px++) {
    if (px < 0 || px >= WIDTH) continue;
    const coverX = Math.min(x1, px + 1) - Math.max(x0, px);
    for (let py = Math.floor(atY); py < y1; py++) {
      const coverY = Math.min(y1, py + 1) - Math.max(atY, py);
      const i = (((py % HEIGHT) + HEIGHT) % HEIGHT) * WIDTH + px;
      frame[i] = Math.round(frame[i]! + (INK - frame[i]!) * dot.alpha * coverX * coverY);
    }
  }
}

/**
 * One dot population plays both roles: a dot's background image is drawn
 * only outside the mask, its glyph image only inside, so densities match by
 * construction and a still frame is just a dot field. Movement is vertical
 * (background down, glyph up); the caption drifts along an ellipse.
 */
function renderDots(mask: Uint8Array, motion: Motion, random: () => number): Uint8Array[] {
  const dots = makeDots(random);

  const frames: Uint8Array[] = [];
  for (let t = 0; t < DOT_FRAMES; t++) {
    const shift = (t / FPS) * DOT_SPEED;
    const groundY =
      motion === 1 ? shift * GROUND_FACTOR : drift(t, DOT_FRAMES, DOT_GROUND_BASE, DOT_WOBBLE, 0);
    const glyphY =
      motion === 1
        ? shift * GLYPH_FACTOR
        : drift(t, DOT_FRAMES, DOT_GLYPH_BASE, DOT_WOBBLE, Math.PI);
    const phase = (2 * Math.PI * t) / DOT_FRAMES;
    const mx = Math.round(ORBIT * Math.cos(phase));
    const my = Math.round((ORBIT / 2) * Math.sin(phase));
    const at = (x: number, y: number) => {
      const sx = Math.round(x) - mx;
      const sy = Math.round(y) - my;
      return sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT
        ? mask[sy * WIDTH + sx] === 1
        : false;
    };
    const frame = new Uint8Array(WIDTH * HEIGHT).fill(PAPER);
    for (const dot of dots) {
      const gy = (((dot.y + groundY) % HEIGHT) + HEIGHT) % HEIGHT;
      if (!at(dot.x, gy)) stampAA(frame, dot, gy);
    }
    for (const dot of dots) {
      const gy = (((dot.y + glyphY) % HEIGHT) + HEIGHT) % HEIGHT;
      if (at(dot.x, gy)) stampAA(frame, dot, gy);
    }
    frames.push(frame);
  }
  return frames;
}

/** Grayscale frames plus the caption mask (used by statistics tests). */
export function renderFrames(
  question: string,
  options: RenderOptions = {},
): { frames: Uint8Array[]; mask: Uint8Array } {
  const { style = 'l', motion = 1, sprinkle = 0, decoyQuestion, random = Math.random } = options;
  const mask = buildMask(question);
  const frames =
    style === 'dots'
      ? renderDots(mask, motion, random)
      : renderBands(mask, style === 'g' ? 1 : 2, motion, random);

  const decoyMask = decoyQuestion ? buildMask(decoyQuestion) : undefined;
  for (const frame of frames) {
    if (decoyMask) {
      for (let i = 0; i < frame.length; i++) {
        if (decoyMask[i]) frame[i] = Math.max(0, frame[i]! - DECOY_SHIFT);
      }
    }
    if (sprinkle > 0) {
      for (let i = 0; i < frame.length; i++) {
        if (random() >= sprinkle) continue;
        frame[i] =
          style === 'dots'
            ? Math.round(PAPER + (INK - PAPER) * (ALPHA_MIN + random() * ALPHA_SPREAD))
            : random() < BAND_DENSITY
              ? BAND_DARK
              : BAND_LIGHT;
      }
    }
  }
  return { frames, mask };
}

/** Grayscale frames → MP4 (Telegram displays it as an animation). */
export async function renderAnimation(
  question: string,
  ffmpegPath = 'ffmpeg',
  options: RenderOptions = {},
): Promise<Uint8Array> {
  const { frames } = renderFrames(question, options);

  const args = [
    '-f', 'rawvideo',
    '-pix_fmt', 'gray',
    '-s', `${WIDTH}x${HEIGHT}`,
    '-r', String(FPS),
    '-i', '-',
    // veryslow halves the size vs veryfast at the same look, encodes <1s.
    '-c:v', 'libx264',
    '-preset', 'veryslow',
    '-crf', '30',
    '-pix_fmt', 'yuv420p',
    '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4',
    '-',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg timed out'));
    }, FFMPEG_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-1500);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(new Uint8Array(Buffer.concat(out)));
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
    });

    for (const frame of frames) child.stdin.write(frame);
    child.stdin.end();
  });
}
