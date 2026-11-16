/**
 * Microsoft Graph Application-Only Certificate Token Provider
 * (`core/src/integrations/email/graphAppTokenProvider.ts`).
 *
 * Implements ADR 0027 §7.2:
 * - Resolves the client certificate from the tenant's own Azure Key Vault
 *   after `assertTenantOwnsKeyVaultSecretRef`.
 * - Verifies SHA-1 thumbprint (`GRAPH_CERT_THUMBPRINT_MISMATCH` on mismatch).
 * - Signs an RFC 7523 RS256 client assertion JWT with `x5t` header and
 *   discards the certificate and private key immediately after assertion signing.
 * - Caches ONLY access tokens per instance in an AES-256-GCM encrypted store
 *   keyed by `buildTenantCacheKey(ctx, 'graph-app-token', ...)`, expiring
 *   300,000 ms (5 minutes) before Entra `expires_in`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createSign,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import type { TenantContext, TenantEmailGraphConfig } from '../../api/index';
import { buildTenantCacheKey } from '../../tenancy/index';
import { assertTenantOwnsKeyVaultSecretRef } from '../../tenancy/keyVaultSecrets';
import { EmailIntegrationError } from './errors';
import {
  DefaultAzureKeyVaultSecretReader,
  type FetchLike,
  type KeyVaultSecretReader,
} from './keyVaultSecretReader';

export const GRAPH_MAIL_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
export const GRAPH_ACCESS_TOKEN_EXPIRY_SKEW_MS = 300_000;
const ENTRA_TOKEN_TIMEOUT_MS = 10_000;

interface EncryptedAccessTokenEntry {
  readonly tenantId: string;
  readonly ivHex: string;
  readonly authTagHex: string;
  readonly ciphertextHex: string;
  readonly expiresAtMs: number;
}

interface ParsedCertificateMaterial {
  readonly certPem: string;
  readonly privateKeyPem: string;
  readonly passphrase?: string;
}

const MAX_ASN1_DEPTH = 32;
const MAX_PKCS12_KDF_ITERATIONS = 1_000_000;

interface Asn1Element {
  readonly tag: number;
  readonly headerLen: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly nextOffset: number;
}

function readAsn1Element(
  buf: Buffer,
  offset: number,
  endLimit: number = buf.length,
  depth: number = 0,
): Asn1Element {
  if (depth > MAX_ASN1_DEPTH) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'PKCS#12 certificate secret exceeded maximum ASN.1 nesting depth.',
    );
  }
  if (offset + 2 > endLimit) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'Unexpected end of ASN.1 data in PKCS#12 certificate secret.',
    );
  }
  const tag = buf[offset]!;
  let pos = offset + 1;
  const lenByte = buf[pos++]!;
  if (lenByte === 0x80) {
    if ((tag & 0x20) === 0) {
      throw new EmailIntegrationError(
        'GRAPH_CERT_PARSE_FAILED',
        'Invalid indefinite-length primitive ASN.1 element in PKCS#12 secret.',
      );
    }
    const contentStart = pos;
    let cursor = pos;
    while (cursor + 1 < endLimit) {
      if (buf[cursor] === 0x00 && buf[cursor + 1] === 0x00) {
        return {
          tag,
          headerLen: contentStart - offset,
          contentStart,
          contentEnd: cursor,
          nextOffset: cursor + 2,
        };
      }
      const child = readAsn1Element(buf, cursor, endLimit, depth + 1);
      cursor = child.nextOffset;
    }
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'Unterminated indefinite-length ASN.1 element in PKCS#12 secret.',
    );
  }

  let length = lenByte;
  if ((lenByte & 0x80) !== 0) {
    const numOctets = lenByte & 0x7f;
    if (numOctets === 0 || numOctets > 4 || pos + numOctets > endLimit) {
      throw new EmailIntegrationError(
        'GRAPH_CERT_PARSE_FAILED',
        'Invalid ASN.1 length encoding in PKCS#12 certificate secret.',
      );
    }
    length = 0;
    for (let i = 0; i < numOctets; i++) {
      length = (length * 256) + buf[pos++]!;
    }
  }
  if (pos + length > endLimit) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'ASN.1 element extends past PKCS#12 certificate secret bounds.',
    );
  }
  return {
    tag,
    headerLen: pos - offset,
    contentStart: pos,
    contentEnd: pos + length,
    nextOffset: pos + length,
  };
}

function readAsn1Children(
  buf: Buffer,
  start: number,
  end: number,
  depth: number = 0,
): Asn1Element[] {
  const children: Asn1Element[] = [];
  let pos = start;
  while (pos < end) {
    if (pos + 1 < end && buf[pos] === 0x00 && buf[pos + 1] === 0x00) {
      break;
    }
    const el = readAsn1Element(buf, pos, end, depth);
    children.push(el);
    pos = el.nextOffset;
  }
  return children;
}

function readAsn1OctetString(buf: Buffer, el: Asn1Element): Buffer {
  if (el.tag === 0x04) {
    return buf.subarray(el.contentStart, el.contentEnd);
  }
  if (el.tag === 0x24) {
    const chunks = readAsn1Children(buf, el.contentStart, el.contentEnd).map(
      (child) => readAsn1OctetString(buf, child),
    );
    return Buffer.concat(chunks);
  }
  throw new EmailIntegrationError(
    'GRAPH_CERT_PARSE_FAILED',
    'Expected ASN.1 OCTET STRING in PKCS#12 certificate secret.',
  );
}

function decodeAsn1Oid(buf: Buffer, start: number, end: number): string {
  if (start >= end) {
    return '';
  }
  const first = buf[start]!;
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = start + 1; i < end; i++) {
    const b = buf[i]!;
    value = (value * 128) + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

function decodeAsn1PositiveInt(buf: Buffer, start: number, end: number): number {
  let value = 0;
  for (let i = start; i < end; i++) {
    value = (value * 256) + buf[i]!;
  }
  return value;
}

function pkcs12KdfEmptyPassword(
  hashAlg: 'sha1' | 'sha256',
  salt: Buffer,
  iterations: number,
  idByte: number,
  keyLen: number,
): Buffer {
  if (
    salt.length === 0 ||
    iterations < 1 ||
    iterations > MAX_PKCS12_KDF_ITERATIONS
  ) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'PKCS#12 KDF parameters are invalid or exceed safe iteration limits.',
    );
  }
  const v = 64;
  const u = hashAlg === 'sha256' ? 32 : 20;
  const D = Buffer.alloc(v, idByte);
  const sLen = v * Math.ceil(salt.length / v);
  const S = Buffer.alloc(sLen);
  for (let i = 0; i < sLen; i++) {
    S[i] = salt[i % salt.length]!;
  }
  // Empty password as BMPString null terminator: [0x00, 0x00] repeated to block v
  const P = Buffer.alloc(v, 0);
  const I = Buffer.concat([S, P]);
  const c = Math.ceil(keyLen / u);
  const outChunks: Buffer[] = [];
  for (let idx = 1; idx <= c; idx++) {
    let Ai = Buffer.concat([D, I]);
    for (let r = 0; r < iterations; r++) {
      Ai = createHash(hashAlg).update(Ai).digest();
    }
    outChunks.push(Ai);
    if (idx < c) {
      const B = Buffer.alloc(v);
      for (let i = 0; i < v; i++) {
        B[i] = Ai[i % Ai.length]!;
      }
      for (let j = 0; j < I.length; j += v) {
        let carry = 1;
        for (let k = v - 1; k >= 0; k--) {
          const sum = I[j + k]! + B[k]! + carry;
          I[j + k] = sum & 0xff;
          carry = sum >> 8;
        }
      }
    }
  }
  return Buffer.concat(outChunks).subarray(0, keyLen);
}

function decryptPkcs12EncryptedBytes(
  algSeqBuf: Buffer,
  cipherBytes: Buffer,
): Buffer {
  const algKids = readAsn1Children(algSeqBuf, 0, algSeqBuf.length);
  if (algKids.length < 2) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'Malformed encryption AlgorithmIdentifier in PKCS#12 secret.',
    );
  }
  const algOid = decodeAsn1Oid(
    algSeqBuf,
    algKids[0]!.contentStart,
    algKids[0]!.contentEnd,
  );

  // pbeWithSHAAnd3-KeyTripleDES-CBC (1.2.840.113549.1.12.1.3)
  if (algOid === '1.2.840.113549.1.12.1.3') {
    const pbeParams = readAsn1Children(
      algSeqBuf,
      algKids[1]!.contentStart,
      algKids[1]!.contentEnd,
    );
    if (pbeParams.length < 2) {
      throw new EmailIntegrationError(
        'GRAPH_CERT_PARSE_FAILED',
        'Malformed PBE parameters in PKCS#12 secret.',
      );
    }
    const salt = readAsn1OctetString(algSeqBuf, pbeParams[0]!);
    const iter = decodeAsn1PositiveInt(
      algSeqBuf,
      pbeParams[1]!.contentStart,
      pbeParams[1]!.contentEnd,
    );
    const key = pkcs12KdfEmptyPassword('sha1', salt, iter, 1, 24);
    const iv = pkcs12KdfEmptyPassword('sha1', salt, iter, 2, 8);
    const decipher = createDecipheriv('des-ede3-cbc', key, iv);
    return Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  }

  // PBES2 (1.2.840.113549.1.5.13)
  if (algOid === '1.2.840.113549.1.5.13') {
    const pbes2Kids = readAsn1Children(
      algSeqBuf,
      algKids[1]!.contentStart,
      algKids[1]!.contentEnd,
    );
    const kdfSeq = readAsn1Children(
      algSeqBuf,
      pbes2Kids[0]!.contentStart,
      pbes2Kids[0]!.contentEnd,
    );
    const pbkdf2Params = readAsn1Children(
      algSeqBuf,
      kdfSeq[1]!.contentStart,
      kdfSeq[1]!.contentEnd,
    );
    const salt = readAsn1OctetString(algSeqBuf, pbkdf2Params[0]!);
    const iter = decodeAsn1PositiveInt(
      algSeqBuf,
      pbkdf2Params[1]!.contentStart,
      pbkdf2Params[1]!.contentEnd,
    );
    if (iter < 1 || iter > MAX_PKCS12_KDF_ITERATIONS) {
      throw new EmailIntegrationError(
        'GRAPH_CERT_PARSE_FAILED',
        'PKCS#12 PBKDF2 iteration count is invalid.',
      );
    }
    let prfHash: 'sha1' | 'sha256' = 'sha1';
    for (let p = 2; p < pbkdf2Params.length; p++) {
      const candidate = pbkdf2Params[p]!;
      if (candidate.tag === 0x30) {
        const prfKids = readAsn1Children(
          algSeqBuf,
          candidate.contentStart,
          candidate.contentEnd,
        );
        if (prfKids[0]) {
          const prfOid = decodeAsn1Oid(
            algSeqBuf,
            prfKids[0].contentStart,
            prfKids[0].contentEnd,
          );
          if (prfOid === '1.2.840.113549.2.9') {
            prfHash = 'sha256';
          }
        }
      }
    }
    const encSeq = readAsn1Children(
      algSeqBuf,
      pbes2Kids[1]!.contentStart,
      pbes2Kids[1]!.contentEnd,
    );
    const encOid = decodeAsn1Oid(
      algSeqBuf,
      encSeq[0]!.contentStart,
      encSeq[0]!.contentEnd,
    );
    const iv = readAsn1OctetString(algSeqBuf, encSeq[1]!);
    const cipherSpec =
      encOid === '2.16.840.1.101.3.4.1.42'
        ? { alg: 'aes-256-cbc', keyLen: 32 }
        : encOid === '2.16.840.1.101.3.4.1.2'
          ? { alg: 'aes-128-cbc', keyLen: 16 }
          : encOid === '1.2.840.113549.3.7'
            ? { alg: 'des-ede3-cbc', keyLen: 24 }
            : null;
    if (!cipherSpec) {
      throw new EmailIntegrationError(
        'GRAPH_CERT_PARSE_FAILED',
        `Unsupported PBES2 cipher OID "${encOid}" in PKCS#12 secret.`,
      );
    }
    const key = pbkdf2Sync('', salt, iter, cipherSpec.keyLen, prfHash);
    const decipher = createDecipheriv(cipherSpec.alg, key, iv);
    return Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
  }

  throw new EmailIntegrationError(
    'GRAPH_CERT_PARSE_FAILED',
    `Unsupported encryption algorithm OID "${algOid}" in PKCS#12 secret.`,
  );
}

function parsePasswordlessPkcs12Base64(
  rawBase64: string,
): ParsedCertificateMaterial {
  const normalized = rawBase64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length < 32) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'Certificate secret must be a PEM bundle, JSON cert/key object, or base64 passwordless PKCS#12 payload.',
    );
  }
  const pfxBuf = Buffer.from(normalized, 'base64');
  if (pfxBuf.length < 16 || pfxBuf[0] !== 0x30) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'Base64 certificate secret is not a valid ASN.1 PKCS#12 PFX container.',
    );
  }

  const pfx = readAsn1Element(pfxBuf, 0);
  const pfxKids = readAsn1Children(pfxBuf, pfx.contentStart, pfx.contentEnd);
  if (pfxKids.length < 2) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'PKCS#12 container is missing authSafe ContentInfo.',
    );
  }
  const authSafeCi = readAsn1Children(
    pfxBuf,
    pfxKids[1]!.contentStart,
    pfxKids[1]!.contentEnd,
  );
  const authSafeWrap = readAsn1Children(
    pfxBuf,
    authSafeCi[1]!.contentStart,
    authSafeCi[1]!.contentEnd,
  )[0]!;
  const authSafeBytes = readAsn1OctetString(pfxBuf, authSafeWrap);
  const authSafeSeq = readAsn1Element(authSafeBytes, 0);
  const contentInfos = readAsn1Children(
    authSafeBytes,
    authSafeSeq.contentStart,
    authSafeSeq.contentEnd,
  );

  let certPem: string | null = null;
  let privateKeyPem: string | null = null;

  for (const ci of contentInfos) {
    const ciKids = readAsn1Children(authSafeBytes, ci.contentStart, ci.contentEnd);
    if (ciKids.length < 2) continue;
    const ciOid = decodeAsn1Oid(
      authSafeBytes,
      ciKids[0]!.contentStart,
      ciKids[0]!.contentEnd,
    );

    let safeContentsBytes: Buffer;
    if (ciOid === '1.2.840.113549.1.7.1') {
      const oct = readAsn1Children(
        authSafeBytes,
        ciKids[1]!.contentStart,
        ciKids[1]!.contentEnd,
      )[0]!;
      safeContentsBytes = readAsn1OctetString(authSafeBytes, oct);
    } else if (ciOid === '1.2.840.113549.1.7.6') {
      const encData = readAsn1Children(
        authSafeBytes,
        ciKids[1]!.contentStart,
        ciKids[1]!.contentEnd,
      )[0]!;
      const encDataKids = readAsn1Children(
        authSafeBytes,
        encData.contentStart,
        encData.contentEnd,
      );
      const eciKids = readAsn1Children(
        authSafeBytes,
        encDataKids[1]!.contentStart,
        encDataKids[1]!.contentEnd,
      );
      const algSeqBytes = authSafeBytes.subarray(
        eciKids[1]!.contentStart,
        eciKids[1]!.contentEnd,
      );
      const cipherBytes = readAsn1OctetString(authSafeBytes, eciKids[2]!);
      safeContentsBytes = decryptPkcs12EncryptedBytes(algSeqBytes, cipherBytes);
    } else {
      continue;
    }

    const scSeq = readAsn1Element(safeContentsBytes, 0);
    const bags = readAsn1Children(
      safeContentsBytes,
      scSeq.contentStart,
      scSeq.contentEnd,
    );
    for (const bag of bags) {
      const bagKids = readAsn1Children(
        safeContentsBytes,
        bag.contentStart,
        bag.contentEnd,
      );
      if (bagKids.length < 2) continue;
      const bagOid = decodeAsn1Oid(
        safeContentsBytes,
        bagKids[0]!.contentStart,
        bagKids[0]!.contentEnd,
      );
      const bagVal = readAsn1Children(
        safeContentsBytes,
        bagKids[1]!.contentStart,
        bagKids[1]!.contentEnd,
      )[0]!;
      const bagDer = safeContentsBytes.subarray(
        bagVal.contentStart - bagVal.headerLen,
        bagVal.contentEnd,
      );

      if (bagOid === '1.2.840.113549.1.12.10.1.1' && !privateKeyPem) {
        privateKeyPem = createPrivateKey({
          key: bagDer,
          format: 'der',
          type: 'pkcs8',
        })
          .export({ format: 'pem', type: 'pkcs8' })
          .toString();
      } else if (bagOid === '1.2.840.113549.1.12.10.1.2' && !privateKeyPem) {
        try {
          privateKeyPem = createPrivateKey({
            key: bagDer,
            format: 'der',
            type: 'pkcs8',
            passphrase: '',
          })
            .export({ format: 'pem', type: 'pkcs8' })
            .toString();
        } catch {
          const epkiSeq = readAsn1Element(bagDer, 0);
          const epkiKids = readAsn1Children(
            bagDer,
            epkiSeq.contentStart,
            epkiSeq.contentEnd,
          );
          const algBytes = bagDer.subarray(
            epkiKids[0]!.contentStart,
            epkiKids[0]!.contentEnd,
          );
          const encBytes = readAsn1OctetString(bagDer, epkiKids[1]!);
          const pkcs8Der = decryptPkcs12EncryptedBytes(algBytes, encBytes);
          privateKeyPem = createPrivateKey({
            key: pkcs8Der,
            format: 'der',
            type: 'pkcs8',
          })
            .export({ format: 'pem', type: 'pkcs8' })
            .toString();
        }
      } else if (bagOid === '1.2.840.113549.1.12.10.1.3' && !certPem) {
        const cbSeq = readAsn1Element(bagDer, 0);
        const cbKids = readAsn1Children(
          bagDer,
          cbSeq.contentStart,
          cbSeq.contentEnd,
        );
        const certOct = readAsn1Children(
          bagDer,
          cbKids[1]!.contentStart,
          cbKids[1]!.contentEnd,
        )[0]!;
        const certDer = readAsn1OctetString(bagDer, certOct);
        certPem = new X509Certificate(certDer).toString();
      }
    }
  }

  if (!certPem || !privateKeyPem) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'PKCS#12 certificate secret did not contain both X.509 certificate and private key bags.',
    );
  }
  return { certPem, privateKeyPem };
}

function parseCertificateMaterial(rawSecret: string): ParsedCertificateMaterial {
  const trimmed = rawSecret.trim();
  if (!trimmed) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'Client certificate Key Vault secret is empty.',
    );
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        certificatePem?: unknown;
        privateKeyPem?: unknown;
        passphrase?: unknown;
      };
      if (
        typeof parsed.certificatePem === 'string' &&
        typeof parsed.privateKeyPem === 'string'
      ) {
        return {
          certPem: parsed.certificatePem,
          privateKeyPem: parsed.privateKeyPem,
          ...(typeof parsed.passphrase === 'string'
            ? { passphrase: parsed.passphrase }
            : {}),
        };
      }
    } catch {
      throw new EmailIntegrationError(
        'GRAPH_CERT_PARSE_FAILED',
        'Invalid JSON structure in Key Vault certificate secret.',
      );
    }
  }

  const certMatch =
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(trimmed);
  const keyMatch =
    /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.exec(
      trimmed,
    );

  if (certMatch?.[0] && keyMatch?.[0]) {
    return {
      certPem: certMatch[0],
      privateKeyPem: keyMatch[0],
    };
  }

  if (!trimmed.includes('-----BEGIN')) {
    return parsePasswordlessPkcs12Base64(trimmed);
  }

  throw new EmailIntegrationError(
    'GRAPH_CERT_PARSE_FAILED',
    'Certificate secret must be a PEM bundle containing both certificate and private key blocks.',
  );
}

function base64UrlEncodeJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function buildRs256ClientAssertion(params: {
  readonly graph: TenantEmailGraphConfig;
  readonly tokenEndpoint: string;
  readonly material: ParsedCertificateMaterial;
  readonly nowMs: number;
}): { readonly jwt: string; readonly thumbprintHex: string } {
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(params.material.certPem);
  } catch {
    throw new EmailIntegrationError(
      'GRAPH_CERT_PARSE_FAILED',
      'Unable to parse X.509 certificate PEM for Microsoft Graph client assertion.',
    );
  }

  const actualThumbprint = x509.fingerprint.replace(/:/g, '').toUpperCase();
  const expectedThumbprint = params.graph.certificateThumbprint
    .trim()
    .toUpperCase();
  if (actualThumbprint !== expectedThumbprint) {
    throw new EmailIntegrationError(
      'GRAPH_CERT_THUMBPRINT_MISMATCH',
      'Microsoft Graph client certificate SHA-1 thumbprint does not match configured certificateThumbprint.',
    );
  }

  const x5t = Buffer.from(actualThumbprint, 'hex').toString('base64url');
  const nowSec = Math.floor(params.nowMs / 1000);
  const header = base64UrlEncodeJson({
    alg: 'RS256',
    typ: 'JWT',
    x5t,
  });
  const payload = base64UrlEncodeJson({
    aud: params.tokenEndpoint,
    iss: params.graph.clientId,
    sub: params.graph.clientId,
    jti: randomUUID(),
    nbf: nowSec - 60,
    iat: nowSec,
    exp: nowSec + 300,
  });
  const signingInput = `${header}.${payload}`;

  const privateKey = createPrivateKey({
    key: params.material.privateKeyPem,
    ...(params.material.passphrase
      ? { passphrase: params.material.passphrase }
      : {}),
  });
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');

  return {
    jwt: `${signingInput}.${signature}`,
    thumbprintHex: actualThumbprint,
  };
}

class InstanceEncryptedAccessTokenCache {
  private readonly encryptionKey: Buffer = randomBytes(32);
  private readonly entries = new Map<string, EncryptedAccessTokenEntry>();

  public get(
    ctx: Pick<TenantContext, 'tenantId'>,
    cacheKey: string,
    nowMs: number,
  ): string | null {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return null;
    }
    if (entry.tenantId !== ctx.tenantId) {
      throw new EmailIntegrationError(
        'TENANCY_CACHE_ISOLATION_ERROR',
        'Cached Graph access token tenant mismatch rejected.',
      );
    }
    if (nowMs >= entry.expiresAtMs - GRAPH_ACCESS_TOKEN_EXPIRY_SKEW_MS) {
      this.entries.delete(cacheKey);
      return null;
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(entry.ivHex, 'hex'),
    );
    decipher.setAAD(Buffer.from(cacheKey, 'utf8'));
    decipher.setAuthTag(Buffer.from(entry.authTagHex, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertextHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
    return plaintext;
  }

  public set(params: {
    readonly ctx: Pick<TenantContext, 'tenantId'>;
    readonly cacheKey: string;
    readonly accessToken: string;
    readonly expiresInSeconds: number;
    readonly nowMs: number;
  }): void {
    const expiresInMs = Math.max(1, Math.floor(params.expiresInSeconds)) * 1000;
    const expiresAtMs = params.nowMs + expiresInMs;
    if (params.nowMs >= expiresAtMs - GRAPH_ACCESS_TOKEN_EXPIRY_SKEW_MS) {
      return;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(params.cacheKey, 'utf8'));
    const encrypted = Buffer.concat([
      cipher.update(params.accessToken, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    this.entries.set(params.cacheKey, {
      tenantId: params.ctx.tenantId,
      ivHex: iv.toString('hex'),
      authTagHex: authTag.toString('hex'),
      ciphertextHex: encrypted.toString('hex'),
      expiresAtMs,
    });
  }

  public readEncryptedSnapshotMetadata(cacheKey: string): {
    readonly exists: boolean;
    readonly ciphertextHex: string | null;
    readonly expiresAtMs: number | null;
  } {
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      return { exists: false, ciphertextHex: null, expiresAtMs: null };
    }
    return {
      exists: true,
      ciphertextHex: entry.ciphertextHex,
      expiresAtMs: entry.expiresAtMs,
    };
  }
}

export class GraphAppTokenProvider {
  private readonly secretReader: KeyVaultSecretReader;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly cache = new InstanceEncryptedAccessTokenCache();

  public constructor(options?: {
    readonly secretReader?: KeyVaultSecretReader;
    readonly fetchFn?: FetchLike;
    readonly now?: () => number;
  }) {
    this.secretReader =
      options?.secretReader ?? new DefaultAzureKeyVaultSecretReader();
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.now = options?.now ?? (() => Date.now());
  }

  public buildCacheKey(
    ctx: Pick<TenantContext, 'tenantId'>,
    graph: Pick<TenantEmailGraphConfig, 'tenantId' | 'clientId'>,
    scope: string = GRAPH_MAIL_DEFAULT_SCOPE,
  ): string {
    return buildTenantCacheKey(
      ctx,
      'graph-app-token',
      `${graph.tenantId}:${graph.clientId}:${scope}`,
    );
  }

  public inspectCacheMetadata(
    ctx: Pick<TenantContext, 'tenantId'>,
    graph: Pick<TenantEmailGraphConfig, 'tenantId' | 'clientId'>,
    scope: string = GRAPH_MAIL_DEFAULT_SCOPE,
  ): {
    readonly exists: boolean;
    readonly ciphertextHex: string | null;
    readonly expiresAtMs: number | null;
  } {
    return this.cache.readEncryptedSnapshotMetadata(
      this.buildCacheKey(ctx, graph, scope),
    );
  }

  public async acquireAppToken(
    ctx: TenantContext,
    graph: TenantEmailGraphConfig,
    scope: string = GRAPH_MAIL_DEFAULT_SCOPE,
  ): Promise<string> {
    assertTenantOwnsKeyVaultSecretRef(ctx, graph.certificateVaultRef);

    const cacheKey = this.buildCacheKey(ctx, graph, scope);
    const currentMs = this.now();
    const cachedToken = this.cache.get(ctx, cacheKey, currentMs);
    if (cachedToken) {
      return cachedToken;
    }

    const rawSecret = await this.secretReader.readSecret(
      ctx,
      graph.certificateVaultRef,
    );
    const material = parseCertificateMaterial(rawSecret);
    const tokenEndpoint = `https://login.microsoftonline.com/${encodeURIComponent(graph.tenantId)}/oauth2/v2.0/token`;

    const { jwt } = buildRs256ClientAssertion({
      graph,
      tokenEndpoint,
      material,
      nowMs: currentMs,
    });

    const body = new URLSearchParams({
      client_id: graph.clientId,
      scope,
      client_assertion_type:
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: jwt,
      grant_type: 'client_credentials',
    });

    const response = await this.fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(ENTRA_TOKEN_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new EmailIntegrationError(
        `GRAPH_TOKEN_HTTP_${response.status}`,
        `Entra client-credentials token request failed with HTTP ${response.status}.`,
      );
    }

    const tokenJson = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (
      typeof tokenJson?.access_token !== 'string' ||
      !tokenJson.access_token.trim()
    ) {
      throw new EmailIntegrationError(
        'GRAPH_TOKEN_RESPONSE_INVALID',
        'Entra token response omitted access_token.',
      );
    }

    const expiresInSeconds =
      typeof tokenJson.expires_in === 'number' &&
      Number.isFinite(tokenJson.expires_in) &&
      tokenJson.expires_in > 0
        ? tokenJson.expires_in
        : 3600;

    this.cache.set({
      ctx,
      cacheKey,
      accessToken: tokenJson.access_token,
      expiresInSeconds,
      nowMs: this.now(),
    });

    return tokenJson.access_token;
  }
}
