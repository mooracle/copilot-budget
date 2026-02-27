import { sanitizeModelName, errorMessage } from './utils';

describe('sanitizeModelName', () => {
  it('passes through safe names unchanged', () => {
    expect(sanitizeModelName('gpt-4o')).toBe('gpt-4o');
    expect(sanitizeModelName('claude-3.5-sonnet')).toBe('claude-3.5-sonnet');
  });

  it('replaces spaces and special characters with underscores', () => {
    expect(sanitizeModelName('model name/v2')).toBe('model_name_v2');
    expect(sanitizeModelName('a@b#c$d')).toBe('a_b_c_d');
  });

  it('handles empty string', () => {
    expect(sanitizeModelName('')).toBe('');
  });
});

describe('errorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('converts non-Error values to string', () => {
    expect(errorMessage('oops')).toBe('oops');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });
});
