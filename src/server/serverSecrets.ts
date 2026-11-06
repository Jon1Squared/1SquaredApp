import 'server-only';

/**
 * Reads a server-side secret from `process.env[name]`.
 * Treats an unset value, a blank string, or an unresolved Azure Key Vault
 * reference (`@Microsoft.KeyVault(...)`) as not configured (`null`).
 */
export function readServerSecret(name: string): string | null {
  const raw = (process.env[name] ?? '').trim();
  if (!raw || /^@Microsoft\.KeyVault\(/i.test(raw)) {
    return null;
  }
  return raw;
}
