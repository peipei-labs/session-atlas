export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError(500, "INTERNAL_ERROR", "The request could not be completed.", {
    cause: error,
  });
}
