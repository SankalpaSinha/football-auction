import { ERROR_MESSAGES, type ErrorCode } from '@fa/shared';

export class GameError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? ERROR_MESSAGES[code]);
  }
}

export function fail(code: ErrorCode, message?: string): never {
  throw new GameError(code, message);
}
