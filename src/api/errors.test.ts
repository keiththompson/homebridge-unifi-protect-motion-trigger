import { describe, expect, it } from 'vitest';

import { ProtectApiError } from './errors.js';

describe('ProtectApiError', () => {
  it('should create an error with message', () => {
    const error = new ProtectApiError('Test error');

    expect(error.message).toBe('Test error');
    expect(error.name).toBe('ProtectApiError');
    expect(error.statusCode).toBeUndefined();
    expect(error.isAuthError).toBe(false);
  });

  it('should create an error with status code', () => {
    const error = new ProtectApiError('Server error', 500);

    expect(error.message).toBe('Server error');
    expect(error.statusCode).toBe(500);
    expect(error.isAuthError).toBe(false);
  });

  it('should identify 401 as auth error', () => {
    const error = new ProtectApiError('Unauthorized', 401);

    expect(error.isAuthError).toBe(true);
  });

  it('should identify 403 as auth error', () => {
    const error = new ProtectApiError('Forbidden', 403);

    expect(error.isAuthError).toBe(true);
  });

  it('should not identify other status codes as auth error', () => {
    const error404 = new ProtectApiError('Not found', 404);
    const error500 = new ProtectApiError('Server error', 500);

    expect(error404.isAuthError).toBe(false);
    expect(error500.isAuthError).toBe(false);
  });
});
