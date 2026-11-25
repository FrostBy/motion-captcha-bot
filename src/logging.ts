import { GrammyError, HttpError } from 'grammy';
import { FetchError } from 'node-fetch';

export type Log = (message: string, context?: Record<string, number | undefined>) => void;

export function errorText(error: unknown): string {
  if (error instanceof HttpError && error.error instanceof FetchError) {
    const cause = error.error;
    // Use the code or type because cause.message can contain the bot token.
    return `${error.message} (${cause.code ?? cause.type})`;
  }
  if (error instanceof GrammyError && error.parameters?.retry_after !== undefined) {
    return `${error.message} (retry after ${error.parameters.retry_after}s)`;
  }
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}
