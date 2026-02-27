/**
 * Replace characters that are not alphanumeric, dots, underscores, or hyphens
 * with underscores. Used when embedding model names in key=value tracking files.
 */
export function sanitizeModelName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Safely extract an error message from an unknown thrown value.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
