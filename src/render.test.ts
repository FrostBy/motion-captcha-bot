import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { renderAnimation, seededRandom } from './captcha.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for ffmpeg. The real binary is not a test dependency: what
 * matters here is that the frames reach it and that its failures surface.
 * Shell scripts only: Windows refuses to spawn a .cmd without a shell, so
 * those two cases run on the platforms the bot is deployed on.
 */
function fakeFfmpeg(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'motion-captcha-ffmpeg-'));
  dirs.push(dir);
  const script = join(dir, 'ffmpeg.sh');
  writeFileSync(script, body);
  chmodSync(script, 0o755);
  return script;
}

const OK_BODY = '#!/bin/sh\ncat > /dev/null\nprintf "fake mp4"\n';
const FAIL_BODY = '#!/bin/sh\ncat > /dev/null\necho broken >&2\nexit 3\n';
const onPosix = it.skipIf(platform === 'win32');

describe('renderAnimation', () => {
  onPosix('returns whatever the encoder wrote to stdout', async () => {
    const video = await renderAnimation('4+2', fakeFfmpeg(OK_BODY), { random: seededRandom(1) });

    expect(Buffer.from(video).toString()).toContain('fake mp4');
  });

  onPosix('reports the exit code and the tail of stderr', async () => {
    await expect(
      renderAnimation('4+2', fakeFfmpeg(FAIL_BODY), { random: seededRandom(1) }),
    ).rejects.toThrow(/code 3.*broken/s);
  });

  it('a missing binary surfaces as a plain error, not a hang', async () => {
    await expect(
      renderAnimation('4+2', join(tmpdir(), 'no-such-ffmpeg-binary'), { random: seededRandom(1) }),
    ).rejects.toThrow();
  });
});
