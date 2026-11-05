/**
 * Phase 1 Contract Harness Suite for SharePoint Document Store (`core/tests/sharepoint-live.integration.test.ts`).
 *
 * Note (R21 / R86): In Phase 1, `SharePointDocumentStoreProvider` is mock-backed (`MockSharePointGraphBackend`).
 * Live Microsoft Graph HTTP transport and Key Vault certificate token exchange are scheduled for Phase 2.
 */

import { describe, expect, it } from 'vitest';
import {
  DocumentStoreProviderRegistry,
  resolveTenantFromVerifiedToken,
  type DocumentStoreConfig,
  type ProvisioningAccessContext,
  type UserAccessContext,
} from '../src/index';

const LIVE_ENABLED =
  process.env.SHAREPOINT_LIVE_TEST_ENABLED === '1' &&
  Boolean(process.env.SHAREPOINT_LIVE_HOSTNAME) &&
  Boolean(process.env.SHAREPOINT_LIVE_SITE_PATH) &&
  Boolean(process.env.SHAREPOINT_LIVE_LIBRARY_SEGMENT) &&
  Boolean(process.env.SHAREPOINT_LIVE_ENTRA_TENANT_ID);

describe.skipIf(!LIVE_ENABLED)(
  'Phase 1 SharePoint Document Store Mock Contract Harness',
  () => {
    it('exercises connection test, folder tree creation, permission assignment, file upload/download, and clean-up', async () => {
      const ctx = resolveTenantFromVerifiedToken({
        verifiedToken: {
          __verifiedByOidcMiddleware: true,
          sub: 'live-test-runner',
          tenantId: 'live-test-tenant',
          name: 'Live Test Runner',
          email: 'live-runner@contoso.example',
          roles: ['admin'],
          entraObjectId:
            process.env.SHAREPOINT_LIVE_TEST_USER_OID ??
            '00000000-0000-0000-0000-000000000001',
          entraTenantId: process.env.SHAREPOINT_LIVE_ENTRA_TENANT_ID!,
          mfaVerified: true,
        },
        hostingMode: 'single_tenant',
        environment: 'test',
        correlationId: `corr-live-${Date.now()}`,
      });

      const storeConfig: DocumentStoreConfig = {
        storeId: 'live-sp-store',
        displayName: 'Live Test SharePoint Store',
        providerType: 'sharepoint',
        isDefault: true,
        enabled: true,
        auth: {
          entraTenantId: process.env.SHAREPOINT_LIVE_ENTRA_TENANT_ID!,
          credentialMode: 'client_certificate',
          clientId: process.env.SHAREPOINT_LIVE_CLIENT_ID ?? 'live-client-id',
          certificateKeyVaultSecretRef:
            'kv://kv-live-test-tenant-test/sp-provisioning-cert',
          delegatedPermissionScope: 'Files.ReadWrite.All',
        },
        sharepoint: {
          hostname: process.env.SHAREPOINT_LIVE_HOSTNAME!,
          siteRelativePath: process.env.SHAREPOINT_LIVE_SITE_PATH!,
          libraries: [
            {
              libraryId: 'live-lib',
              displayName: process.env.SHAREPOINT_LIVE_LIBRARY_SEGMENT!,
              libraryUrlSegment: process.env.SHAREPOINT_LIVE_LIBRARY_SEGMENT!,
            },
          ],
        },
      };

      const registry = new DocumentStoreProviderRegistry();
      const provider = registry.createProvider(ctx, storeConfig);

      const provCtx: ProvisioningAccessContext = {
        kind: 'provisioning',
        tenantContext: ctx,
        triggeredByUserId: ctx.actorId,
        triggerEvent: 'live.integration.test',
      };
      const userCtx: UserAccessContext = {
        kind: 'user',
        tenantContext: ctx,
        actorUserId: ctx.actorId,
        entraObjectId: ctx.entraObjectId!,
        userAssertionToken:
          process.env.SHAREPOINT_LIVE_USER_ASSERTION ?? 'live-assertion',
      };

      // 1. Test connection
      const conn = await provider.testConnection(provCtx);
      expect(conn.ok).toBe(true);

      // 2. Resolve library root
      const resolved = await provider.resolveLocation(provCtx, {
        storeId: storeConfig.storeId,
        rawUrlOrPath: `https://${storeConfig.sharepoint!.hostname}${storeConfig.sharepoint!.siteRelativePath}/${encodeURIComponent(storeConfig.sharepoint!.libraries[0]!.libraryUrlSegment)}`,
      });
      expect(resolved.resolved).toBe(true);

      // 3. Create temporary test folder tree
      const runFolderName = `ITEST-${Date.now()}`;
      const ensured = await provider.ensureFolderTree(
        provCtx,
        {
          storeId: storeConfig.storeId,
          libraryId: 'live-lib',
          siteId: resolved.siteId!,
          driveId: resolved.driveId!,
          folderItemId: 'root',
        },
        [
          {
            name: runFolderName,
            relativePath: runFolderName,
            children: [
              {
                name: '01 Client Care',
                relativePath: `${runFolderName}/01 Client Care`,
              },
            ],
          },
        ],
      );
      const testFolderId = ensured.folderItemMap[runFolderName]!;
      expect(testFolderId).toBeDefined();

      // 4. Set permissions & verify
      await provider.setPermissions(
        provCtx,
        {
          storeId: storeConfig.storeId,
          siteId: resolved.siteId!,
          driveId: resolved.driveId!,
          itemId: testFolderId,
        },
        [
          {
            principal: {
              principalType: 'user',
              entraObjectId: ctx.entraObjectId!,
              displayName: 'Live Test User',
            },
            level: 'edit',
          },
        ],
        { inherit: false },
      );

      // 5. Upload & download a file
      const payloadBytes = new TextEncoder().encode('Live SharePoint integration verification');
      const uploaded = await provider.uploadContent(
        userCtx,
        {
          storeId: storeConfig.storeId,
          libraryId: 'live-lib',
          siteId: resolved.siteId!,
          driveId: resolved.driveId!,
          folderItemId: testFolderId,
        },
        'verification.txt',
        payloadBytes,
        payloadBytes.byteLength,
      );
      expect(uploaded.name).toBe('verification.txt');

      const downloaded = await provider.downloadContent(userCtx, {
        storeId: storeConfig.storeId,
        siteId: resolved.siteId!,
        driveId: resolved.driveId!,
        itemId: uploaded.itemId,
      });
      const reader = downloaded.stream.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(
        'Live SharePoint integration verification',
      );

      // 6. Clean up test folder
      await provider.deleteItem(userCtx, {
        storeId: storeConfig.storeId,
        siteId: resolved.siteId!,
        driveId: resolved.driveId!,
        itemId: testFolderId,
      });
    });
  },
);
