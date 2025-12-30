export class ProtectApiError extends Error {
  public readonly statusCode?: number;
  public readonly isAuthError: boolean;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ProtectApiError';
    this.statusCode = statusCode;
    this.isAuthError = statusCode === 401 || statusCode === 403;
  }
}
