export class ServerError extends Error {
  statusCode: number;
  constructor(
    message: string,
    statusCode: number,
    // options?: ErrorOptions // Requires ES2022+ target. Uncomment when tsconfig is updated.
  ) {
    super(message /*, options */);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class BadRequestError extends ServerError {
  constructor(
    message: string,
    // options?: ErrorOptions // Requires ES2022+ target. Uncomment when tsconfig is updated.
  ) {
    super(message, 400 /*, options */);
  }
}

export function isServerError(error: unknown): error is ServerError {
  return error instanceof ServerError;
}
