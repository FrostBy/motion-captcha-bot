import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A newcomer waiting to answer the captcha. */
export interface Pending {
  /** The expected sum. */
  answer: number;
  /** Sum of the baked-in fake expression; matching it outs a bot. */
  decoyAnswer?: number;
  /** Expiration moment, ms epoch. */
  deadline: number;
  /** The captcha message, deleted whatever the outcome. */
  captchaMessageId: number;
  /** Wrong answers so far; too many of them means a kick. */
  attempts?: number;
  /** For the %username% placeholder in the welcome message. */
  firstName?: string;
}

/**
 * How long a kick stays marked as "ours". The ban/unban chat_member updates
 * arrive after the pending record is gone; without the marker they would
 * read as "seen inside" and whitelist the very user we just kicked.
 */
const KICK_MARKER_TTL_MS = 60_000;

interface ChatState {
  passed: number[];
  pending: Record<string, Pending>;
}

interface Snapshot {
  chats: Record<string, ChatState>;
}

/**
 * In-memory state with an on-disk snapshot: written every interval when
 * dirty and on shutdown, atomically (tmp + rename). Losing the last few
 * seconds is fine: worst case someone sees the captcha twice.
 */
export class State {
  private chats = new Map<number, { passed: Set<number>; pending: Map<number, Pending> }>();
  /** In-flight/recent kicks by "chatId:userId", value is the marker expiry. Not persisted. */
  private kicks = new Map<string, number>();
  private dirty = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly file: string,
    private readonly flushMs = 5000,
  ) {}

  /** A corrupt or missing snapshot means an empty start, not a crash. */
  load(warn: (message: string) => void = console.warn): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      const snapshot = JSON.parse(raw) as Snapshot;
      // Build aside and assign at the end: a malformed chat in the middle
      // must not leave the state half-populated.
      const chats = new Map<number, { passed: Set<number>; pending: Map<number, Pending> }>();
      for (const [chatId, chat] of Object.entries(snapshot.chats ?? {})) {
        chats.set(Number(chatId), {
          passed: new Set(chat.passed ?? []),
          pending: new Map(
            Object.entries(chat.pending ?? {}).map(([userId, p]) => [Number(userId), p]),
          ),
        });
      }
      this.chats = chats;
    } catch {
      warn(`Snapshot ${this.file} does not parse, starting empty`);
    }
  }

  startFlusher(): void {
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot: Snapshot = { chats: {} };
    for (const [chatId, chat] of this.chats) {
      snapshot.chats[chatId] = {
        passed: [...chat.passed],
        pending: Object.fromEntries(chat.pending),
      };
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot));
    await rename(tmp, this.file);
  }

  private chat(chatId: number) {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { passed: new Set(), pending: new Map() };
      this.chats.set(chatId, chat);
    }
    return chat;
  }

  isPassed(chatId: number, userId: number): boolean {
    return this.chats.get(chatId)?.passed.has(userId) ?? false;
  }

  markPassed(chatId: number, userId: number): void {
    const chat = this.chat(chatId);
    chat.pending.delete(userId);
    if (!chat.passed.has(userId)) {
      chat.passed.add(userId);
      this.dirty = true;
    }
  }

  getPending(chatId: number, userId: number): Pending | undefined {
    return this.chats.get(chatId)?.pending.get(userId);
  }

  setPending(chatId: number, userId: number, pending: Pending): void {
    this.chat(chatId).pending.set(userId, pending);
    this.dirty = true;
  }

  clearPending(chatId: number, userId: number): void {
    if (this.chat(chatId).pending.delete(userId)) this.dirty = true;
  }

  /** Remember that the bot itself is kicking this user right now. */
  markKicking(chatId: number, userId: number, now: number): void {
    this.kicks.set(`${chatId}:${userId}`, now + KICK_MARKER_TTL_MS);
  }

  /** Is a recent kick of this user ours? Expired markers are swept lazily. */
  isKicking(chatId: number, userId: number, now: number): boolean {
    const key = `${chatId}:${userId}`;
    const until = this.kicks.get(key);
    if (until === undefined) return false;
    if (until <= now) {
      this.kicks.delete(key);
      return false;
    }
    return true;
  }

  /** Everyone expired as of `now`, to be kicked, restart survivors included. */
  expired(now: number): Array<{ chatId: number; userId: number; pending: Pending }> {
    const out: Array<{ chatId: number; userId: number; pending: Pending }> = [];
    for (const [chatId, chat] of this.chats) {
      for (const [userId, pending] of chat.pending) {
        if (pending.deadline <= now) out.push({ chatId, userId, pending });
      }
    }
    return out;
  }
}
