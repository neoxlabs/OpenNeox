export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function toHttpError(error) {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.code } };
  }
  return { status: 500, body: { error: 'INTERNAL' } };
}
