/**
 * Email Transport Adapters & Core `EmailSender` Dispatcher
 * (`core/src/integrations/email/adapters.ts`).
 *
 * Implements ADR 0027:
 * - Four adapters behind `EmailSender`: `disabled`, `dev_catcher` (real SMTP TCP
 *   client for local Mailpit/catcher verification), `graph` (Microsoft Graph
 *   application-only `/users/{mailbox}/sendMail`), and fail-closed `acs`
 *   (`EMAIL_PROVIDER_NOT_IMPLEMENTED`).
 * - Resolves attachments via `DocumentStorageProvider.getObjectBytes(ctx, { blobKey })`
 *   enforcing `assertBlobKeyBelongsToTenant`.
 * - Enforces non-live recipient allow-listing BEFORE invoking any active adapter.
 */

import { randomUUID } from 'node:crypto';
import type net from 'node:net';
import type tls from 'node:tls';

function getNodeBuiltin<T>(specifier: string, errorCode: string): T {
  if (
    typeof window !== 'undefined' ||
    typeof process.getBuiltinModule !== 'function'
  ) {
    throw new EmailIntegrationError(
      errorCode,
      `${specifier} is available only in the Node.js server runtime.`,
    );
  }
  const mod = process.getBuiltinModule(specifier) as T | undefined;
  if (!mod) {
    throw new EmailIntegrationError(
      errorCode,
      `Unable to load Node.js builtin ${specifier}.`,
    );
  }
  return mod;
}
import type {
  DocumentStorageProvider,
  EmailAttachmentRef,
  EmailProviderId,
  EmailRecipientList,
  EmailSender,
  EmailSendResult,
  OutgoingEmail,
  TenantConfiguration,
  TenantContext,
  TenantEmailAcsConfig,
  TenantEmailDevCatcherConfig,
  TenantEmailGraphConfig,
  TenantEmailIntegrationConfig,
} from '../../api/index';
import { assertTenantOwnsKeyVaultSecretRef } from '../../tenancy/keyVaultSecrets';
import { evaluateEmailAllowList } from './allowList';
import { EmailIntegrationError } from './errors';
import { GraphAppTokenProvider } from './graphAppTokenProvider';
import {
  type FetchLike,
  type KeyVaultSecretReader,
} from './keyVaultSecretReader';

const GRAPH_SEND_TIMEOUT_MS = 15_000;
const SMTP_TIMEOUT_MS = 10_000;

export interface LoadedEmailAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly contentBase64: string;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function dotStuffSmtpLines(raw: string): string {
  const normalized = raw.replace(/\r?\n/g, '\r\n');
  return normalized
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

function wrapBase64(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

export function buildMimeEmailMessage(params: {
  readonly from: string;
  readonly replyTo?: string;
  readonly recipients: EmailRecipientList;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly attachments: readonly LoadedEmailAttachment[];
  readonly messageId: string;
}): string {
  const altBoundary = `=_alt_${randomUUID()}`;
  const mixedBoundary = `=_mix_${randomUUID()}`;
  const headers: string[] = [
    `From: <${sanitizeHeaderValue(params.from)}>`,
    `To: ${params.recipients.to.map((a) => `<${sanitizeHeaderValue(a)}>`).join(', ')}`,
  ];
  if (params.recipients.cc && params.recipients.cc.length > 0) {
    headers.push(
      `Cc: ${params.recipients.cc.map((a) => `<${sanitizeHeaderValue(a)}>`).join(', ')}`,
    );
  }
  if (params.replyTo) {
    headers.push(`Reply-To: <${sanitizeHeaderValue(params.replyTo)}>`);
  }
  headers.push(
    `Subject: ${sanitizeHeaderValue(params.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${sanitizeHeaderValue(params.messageId)}`,
    'MIME-Version: 1.0',
  );

  const alternativeBody = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(params.textBody, 'utf8').toString('base64')),
    `--${altBoundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(params.htmlBody, 'utf8').toString('base64')),
    `--${altBoundary}--`,
  ].join('\r\n');

  if (params.attachments.length === 0) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      alternativeBody,
    ].join('\r\n');
  }

  const parts: string[] = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    '',
    alternativeBody,
  ];
  for (const att of params.attachments) {
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${sanitizeHeaderValue(att.contentType)}; name="${sanitizeHeaderValue(att.fileName)}"`,
      `Content-Disposition: attachment; filename="${sanitizeHeaderValue(att.fileName)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(att.contentBase64),
    );
  }
  parts.push(`--${mixedBoundary}--`);

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    parts.join('\r\n'),
  ].join('\r\n');
}

async function sendSmtpViaTcpCatcher(params: {
  readonly devCatcher: TenantEmailDevCatcherConfig;
  readonly from: string;
  readonly replyTo?: string;
  readonly recipients: EmailRecipientList;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly attachments: readonly LoadedEmailAttachment[];
}): Promise<string> {
  const host = params.devCatcher.host || '127.0.0.1';
  const port = params.devCatcher.port || 1025;
  const secure = params.devCatcher.secure === true;
  const domain = params.from.split('@')[1] ?? 'notalawfirm.example';
  const messageId = `<${randomUUID()}@${domain}>`;
  const envelopeRecipients = [
    ...params.recipients.to,
    ...(params.recipients.cc ?? []),
    ...(params.recipients.bcc ?? []),
  ];
  const rawMime = buildMimeEmailMessage({
    from: params.from,
    replyTo: params.replyTo,
    recipients: params.recipients,
    subject: params.subject,
    htmlBody: params.htmlBody,
    textBody: params.textBody,
    attachments: params.attachments,
    messageId,
  });

  const socket: net.Socket | tls.TLSSocket = secure
    ? getNodeBuiltin<typeof tls>('node:tls', 'EMAIL_SMTP_SERVER_RUNTIME_REQUIRED').connect({
        host,
        port,
      })
    : getNodeBuiltin<typeof net>('node:net', 'EMAIL_SMTP_SERVER_RUNTIME_REQUIRED').createConnection({
        host,
        port,
      });

  socket.setTimeout(SMTP_TIMEOUT_MS);

  let buffer = '';
  let multiLineParts: string[] = [];
  let closed = false;
  let pendingResolve: ((line: { code: number; text: string }) => void) | null =
    null;
  let pendingReject: ((err: Error) => void) | null = null;
  const completedResponses: Array<{ code: number; text: string }> = [];

  const fail = (err: Error) => {
    if (closed) {
      return;
    }
    closed = true;
    const reject = pendingReject;
    pendingResolve = null;
    pendingReject = null;
    socket.destroy();
    reject?.(err);
  };

  socket.on('timeout', () => {
    fail(
      new EmailIntegrationError(
        'EMAIL_SMTP_TIMEOUT',
        `SMTP connection to dev_catcher (${host}:${port}) timed out.`,
      ),
    );
  });

  socket.on('error', (err) => {
    fail(
      new EmailIntegrationError(
        'EMAIL_SMTP_CONNECTION_FAILED',
        `SMTP connection to dev_catcher failed: ${err.message}`,
      ),
    );
  });

  socket.on('close', () => {
    if (!closed && pendingReject) {
      fail(
        new EmailIntegrationError(
          'EMAIL_SMTP_CONNECTION_CLOSED',
          'SMTP connection closed unexpectedly before completing transaction.',
        ),
      );
    }
    closed = true;
  });

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const nlIdx = buffer.indexOf('\r\n');
      const lfIdx = nlIdx >= 0 ? nlIdx : buffer.indexOf('\n');
      if (lfIdx < 0) {
        break;
      }
      const lineLen = nlIdx >= 0 ? 2 : 1;
      const line = buffer.slice(0, lfIdx);
      buffer = buffer.slice(lfIdx + lineLen);
      if (line.length < 3) {
        continue;
      }
      const code = Number.parseInt(line.slice(0, 3), 10);
      const separator = line[3] ?? ' ';
      multiLineParts.push(line);
      if (separator !== '-') {
        const response = { code, text: multiLineParts.join('\n') };
        multiLineParts = [];
        if (pendingResolve) {
          const res = pendingResolve;
          pendingResolve = null;
          pendingReject = null;
          res(response);
        } else {
          completedResponses.push(response);
        }
      }
    }
  });

  const readResponse = (): Promise<{ code: number; text: string }> => {
    const queued = completedResponses.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (closed) {
      return Promise.reject(
        new EmailIntegrationError(
          'EMAIL_SMTP_CONNECTION_CLOSED',
          'SMTP connection is already closed.',
        ),
      );
    }
    return new Promise((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;
    });
  };

  const sendCommand = async (
    command: string,
    expectedCodes: readonly number[],
  ): Promise<{ code: number; text: string }> => {
    socket.write(`${command}\r\n`);
    const reply = await readResponse();
    if (!expectedCodes.includes(reply.code)) {
      throw new EmailIntegrationError(
        `EMAIL_SMTP_REPLY_${reply.code}`,
        `Unexpected SMTP response ${reply.code} for command.`,
      );
    }
    return reply;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const greeting = await readResponse();
    if (greeting.code !== 220) {
      throw new EmailIntegrationError(
        `EMAIL_SMTP_GREETING_${greeting.code}`,
        `Unexpected SMTP greeting code ${greeting.code}.`,
      );
    }
    await sendCommand(`EHLO ${domain}`, [250]);
    await sendCommand(`MAIL FROM:<${sanitizeHeaderValue(params.from)}>`, [250]);
    for (const rcpt of envelopeRecipients) {
      await sendCommand(`RCPT TO:<${sanitizeHeaderValue(rcpt)}>`, [250, 251]);
    }
    await sendCommand('DATA', [354]);
    socket.write(`${dotStuffSmtpLines(rawMime)}\r\n.\r\n`);
    const dataAck = await readResponse();
    if (dataAck.code !== 250) {
      throw new EmailIntegrationError(
        `EMAIL_SMTP_DATA_${dataAck.code}`,
        `SMTP server rejected message DATA with code ${dataAck.code}.`,
      );
    }
    try {
      await sendCommand('QUIT', [221]);
    } catch {
      // Best-effort QUIT after successful 250 DATA confirmation
    }
    return messageId;
  } finally {
    closed = true;
    socket.destroy();
  }
}

async function resolveLoadedAttachments(
  ctx: TenantContext,
  refs: readonly EmailAttachmentRef[],
  storageProvider?: DocumentStorageProvider,
): Promise<LoadedEmailAttachment[]> {
  if (refs.length === 0) {
    return [];
  }
  if (!storageProvider) {
    throw new EmailIntegrationError(
      'EMAIL_ATTACHMENT_STORAGE_UNAVAILABLE',
      'Cannot resolve outbound email attachments without a configured DocumentStorageProvider.',
    );
  }
  const loaded: LoadedEmailAttachment[] = [];
  for (const att of refs) {
    const bytes = await storageProvider.getObjectBytes(ctx, {
      blobKey: att.blobKey,
      ...(att.externalId ? { externalId: att.externalId } : {}),
    });
    loaded.push({
      fileName: att.fileName,
      contentType: att.contentType,
      contentBase64: Buffer.from(bytes).toString('base64'),
    });
  }
  return loaded;
}

export function resolveEmailIntegrationConfig(
  tenantConfig: TenantConfiguration,
): TenantEmailIntegrationConfig {
  const integrations = tenantConfig.integrations;
  const email = integrations?.email;
  if (!email) {
    return { provider: 'disabled' };
  }
  return email;
}

export class CoreEmailDispatcher implements EmailSender {
  public readonly provider: EmailProviderId;
  private readonly getEmailConfig: (
    ctx: TenantContext,
  ) => TenantEmailIntegrationConfig;
  private readonly secretReader?: KeyVaultSecretReader;
  private readonly graphTokenProvider: GraphAppTokenProvider;
  private readonly storageProvider?: DocumentStorageProvider;
  private readonly fetchFn: FetchLike;

  public constructor(options: {
    readonly emailConfig:
      | TenantEmailIntegrationConfig
      | ((ctx: TenantContext) => TenantEmailIntegrationConfig);
    readonly secretReader?: KeyVaultSecretReader;
    readonly graphTokenProvider?: GraphAppTokenProvider;
    readonly storageProvider?: DocumentStorageProvider;
    readonly fetchFn?: FetchLike;
  }) {
    const resolver =
      typeof options.emailConfig === 'function'
        ? options.emailConfig
        : () => options.emailConfig as TenantEmailIntegrationConfig;
    this.getEmailConfig = resolver;
    this.provider =
      typeof options.emailConfig === 'function'
        ? 'disabled'
        : options.emailConfig.provider;
    this.secretReader = options.secretReader;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.graphTokenProvider =
      options.graphTokenProvider ??
      new GraphAppTokenProvider({
        secretReader: options.secretReader,
        fetchFn: this.fetchFn,
      });
    this.storageProvider = options.storageProvider;
  }

  public async send(
    ctx: TenantContext,
    message: OutgoingEmail,
  ): Promise<EmailSendResult> {
    const email = this.getEmailConfig(ctx);
    const provider = email.provider ?? 'disabled';

    if (provider === 'disabled') {
      return {
        status: 'disabled',
        provider: 'disabled',
        providerMessageId: null,
      };
    }

    // Shared non-live allow-list guard runs BEFORE any active adapter executes (ADR 0027 §6.2)
    const allowListDecision = await evaluateEmailAllowList(
      ctx,
      email,
      message.recipients,
      { secretReader: this.secretReader },
    );
    if (!allowListDecision.allowed) {
      return {
        status: 'dropped_allowlist',
        provider,
        providerMessageId: null,
        blockedRecipients: allowListDecision.blockedRecipients,
        errorCode: allowListDecision.reason ?? 'EMAIL_ALLOWLIST_BLOCKED',
      };
    }

    const senderAddress =
      message.from?.trim() || email.senderAddress?.trim() || '';
    const replyTo = message.replyTo?.trim() || email.replyTo?.trim() || undefined;
    const loadedAttachments = await resolveLoadedAttachments(
      ctx,
      message.attachments ?? [],
      this.storageProvider,
    );

    if (provider === 'acs') {
      const acs: TenantEmailAcsConfig | undefined = email.acs;
      if (acs?.connectionVaultRef) {
        assertTenantOwnsKeyVaultSecretRef(ctx, acs.connectionVaultRef);
      }
      throw new EmailIntegrationError(
        'EMAIL_PROVIDER_NOT_IMPLEMENTED',
        'Azure Communication Services email transport is not implemented in Stage 0 (ADR 0027).',
      );
    }

    if (provider === 'dev_catcher') {
      if (ctx.environment === 'live') {
        throw new EmailIntegrationError(
          'EMAIL_DEV_CATCHER_FORBIDDEN_IN_LIVE',
          'The dev_catcher email provider cannot be used in live environments.',
        );
      }
      if (!senderAddress) {
        throw new EmailIntegrationError(
          'EMAIL_SENDER_ADDRESS_REQUIRED',
          'integrations.email.senderAddress is required for dev_catcher email delivery.',
        );
      }
      const devCatcher: TenantEmailDevCatcherConfig = email.devCatcher ?? {
        host: '127.0.0.1',
        port: 1025,
        secure: false,
      };
      const messageId = await sendSmtpViaTcpCatcher({
        devCatcher,
        from: senderAddress,
        replyTo,
        recipients: message.recipients,
        subject: message.subject,
        htmlBody: message.htmlBody,
        textBody: message.textBody,
        attachments: loadedAttachments,
      });
      return {
        status: 'sent',
        provider: 'dev_catcher',
        providerMessageId: messageId,
      };
    }

    // provider === 'graph'
    const graph: TenantEmailGraphConfig | undefined = email.graph;
    if (!graph) {
      throw new EmailIntegrationError(
        'EMAIL_GRAPH_NOT_CONFIGURED',
        'integrations.email.graph configuration is required when provider is "graph".',
      );
    }
    if (!senderAddress) {
      throw new EmailIntegrationError(
        'EMAIL_SENDER_ADDRESS_REQUIRED',
        'integrations.email.senderAddress is required for Microsoft Graph email delivery.',
      );
    }

    const token = await this.graphTokenProvider.acquireAppToken(ctx, graph);
    const toRecipients = message.recipients.to.map((address) => ({
      emailAddress: { address },
    }));
    const ccRecipients = (message.recipients.cc ?? []).map((address) => ({
      emailAddress: { address },
    }));
    const bccRecipients = (message.recipients.bcc ?? []).map((address) => ({
      emailAddress: { address },
    }));

    const graphPayload: Record<string, unknown> = {
      message: {
        subject: message.subject,
        body: {
          contentType: 'HTML',
          content: message.htmlBody,
        },
        from: {
          emailAddress: { address: senderAddress },
        },
        toRecipients,
        ...(ccRecipients.length > 0 ? { ccRecipients } : {}),
        ...(bccRecipients.length > 0 ? { bccRecipients } : {}),
        ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
        ...(loadedAttachments.length > 0
          ? {
              attachments: loadedAttachments.map((att) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: att.fileName,
                contentType: att.contentType,
                contentBytes: att.contentBase64,
              })),
            }
          : {}),
      },
      saveToSentItems: false,
    };

    const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderAddress)}/sendMail`;
    const response = await this.fetchFn(sendUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(graphPayload),
      signal: AbortSignal.timeout(GRAPH_SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new EmailIntegrationError(
        `EMAIL_GRAPH_HTTP_${response.status}`,
        `Microsoft Graph sendMail request failed with HTTP ${response.status}.`,
      );
    }

    const providerMessageId =
      response.headers.get('request-id') ??
      response.headers.get('client-request-id') ??
      `graph-${randomUUID()}`;

    return {
      status: 'sent',
      provider: 'graph',
      providerMessageId,
    };
  }
}
