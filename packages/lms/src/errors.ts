import type { CanvasErrorCode } from './types';

export class CanvasError extends Error {
  readonly code: CanvasErrorCode;
  readonly status?: number;
  readonly endpoint?: string;
  readonly causeMessage?: string;

  constructor(
    code: CanvasErrorCode,
    message: string,
    options: { status?: number; endpoint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CanvasError';
    this.code = code;
    this.status = options.status;
    this.endpoint = options.endpoint;
    this.causeMessage =
      options.cause instanceof Error
        ? options.cause.message
        : typeof options.cause === 'string'
          ? options.cause
          : undefined;
  }
}

export function asCanvasError(error: unknown): CanvasError {
  if (error instanceof CanvasError) return error;
  return new CanvasError('canvas_unreachable', 'Canvas could not be reached.', { cause: error });
}
