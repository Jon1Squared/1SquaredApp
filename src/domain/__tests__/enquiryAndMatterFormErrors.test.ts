import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getMissingRoutingFields, validateEnquiryInput } from '@/domain/enquiries';
import { buildDefaultOrgStructure } from '@/domain/orgStructure';
import { createDefaultMatterCostsConfig } from '@/domain/matterCosts';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';
import { getIntakeQuoteRepository, saveEnquiryRecord } from '@/server/services';
import { importFirmStoreModulesToPostgres } from '@/server/storePostgresImport';
import { runAsTestActor, testTenantCtx } from '@/server/testSupport/auditTestSupport';
import { testSecondTenantContext } from '@/test/testTenantContexts';
import { EnquiryFormClient } from '@/components/EnquiryFormClient';
import { MatterFormClient } from '@/components/MatterFormClient';
import { ToastProvider } from '@/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    refresh: () => {},
    replace: () => {},
    back: () => {},
  }),
  usePathname: () => '/enquiries/new',
  useSearchParams: () => new URLSearchParams(),
}));

describe('R656: Enquiry privacy-notice routing requirement & unmapped form error summaries', () => {
  it('includes privacy notice in getMissingRoutingFields unless requirePrivacyNotice is false', () => {
    const baseInput = {
      firstName: 'Gareth',
      lastName: 'Pritchard',
      phone: '029 2010 5566',
      practiceAreaId: 'work_type.corporate_and_commercial',
      summary: 'Commercial supply contract review',
      notes: 'Caller requests review before signing next week.',
      privacyNoticeGiven: false,
    };

    const missing = getMissingRoutingFields(baseInput, []);
    expect(missing).toContain('privacy notice');

    const withPrivacy = getMissingRoutingFields(
      { ...baseInput, privacyNoticeGiven: true },
      [],
    );
    expect(withPrivacy).toEqual([]);

    const legacyRouted = getMissingRoutingFields(baseInput, [], {
      requirePrivacyNotice: false,
    });
    expect(legacyRouted).toEqual([]);

    const validationErrs = validateEnquiryInput({
      ...baseInput,
      channelId: 'enquiry_channel.phone',
      urgencyId: 'enquiry_urgency.standard',
    });
    expect(validationErrs.privacyNoticeGiven).toBeDefined();
  });

  it('saveEnquiryRecord reports missingFields for privacy notice, routes when confirmed, allows legacy non-draft edits, and enforces two-tenant isolation', async () => {
    const basePayload = {
      channelId: 'enquiry_channel.phone',
      firstName: 'Carys',
      lastName: 'Jenkins',
      phone: '029 2010 7789',
      practiceAreaId: 'work_type.corporate_and_commercial',
      summary: 'Supply contract review (R656)',
      notes: 'Requires initial contract review.',
      urgencyId: 'enquiry_urgency.standard',
      privacyNoticeGiven: false,
    };

    const rejected = await runAsTestActor('P-000002', () =>
      saveEnquiryRecord(basePayload, { asDraft: false, byId: 'P-000002' }),
    );
    expect(rejected.errors?.privacyNoticeGiven).toBe(
      'Please confirm the privacy notice was read or sent to the caller.',
    );
    expect(rejected.missingFields).toContain('privacy notice');

    const saved = await runAsTestActor('P-000002', () =>
      saveEnquiryRecord(
        { ...basePayload, privacyNoticeGiven: true },
        { asDraft: false, byId: 'P-000002' },
      ),
    );
    expect(saved.errors).toBeUndefined();
    expect(saved.enquiry?.status).toBe('New');
    expect(saved.enquiry?.assignedTeamId).toBe('TM-000002');
    expect(saved.routedTeamName).toBe('Corporate & Commercial');

    // Legacy routed enquiry with privacyNoticeGiven: false can still be edited without confirming privacy notice
    const seed = loadCommittedSeedStore();
    const legacyEnquiry = seed.enquiries.find((e) => e.status === 'New');
    if (legacyEnquiry) {
      const intakeRepo = getIntakeQuoteRepository();
      const ctxA = testTenantCtx('P-000002');
      await intakeRepo.withTenantTransaction(ctxA, async () => {
        await intakeRepo.putEnquiry(ctxA, {
          ...legacyEnquiry,
          privacyNoticeGiven: false,
        });
      });
      const editedLegacy = await runAsTestActor('P-000002', () =>
        saveEnquiryRecord(
          {
            ...legacyEnquiry,
            privacyNoticeGiven: false,
            notes: 'Updated notes on legacy enquiry',
          },
          { id: legacyEnquiry.id, asDraft: false, byId: 'P-000002' },
        ),
      );
      expect(editedLegacy.errors).toBeUndefined();
    }

    // Two-tenant isolation check: second tenant DB cannot see saved enquiry created in not-a-law-firm
    const ctxB = testSecondTenantContext('fictional-chambers-uk');
    expect(ctxB.postgresDatabaseName).not.toBe(
      testTenantCtx('P-000002').postgresDatabaseName,
    );
    const intakeRepoB = getIntakeQuoteRepository();
    const crossTenantEnquiry = await intakeRepoB.withTenantTransaction(ctxB, async () =>
      intakeRepoB.getEnquiryById(ctxB, saved.enquiry!.id),
    );
    expect(crossTenantEnquiry).toBeNull();
  });

  afterAll(async () => {
    await importFirmStoreModulesToPostgres({
      ctx: testTenantCtx('P-000004'),
      store: loadCommittedSeedStore(),
      clearFirst: true,
    });
  }, 30_000);

  it('EnquiryFormClient marks privacy notice required and displays unmapped server error summary without duplicating mapped errors', () => {
    const store = loadCommittedSeedStore();
    const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
    const draftWithNamesNoPrivacy = {
      ...store.enquiries[0]!,
      id: 'ENQ-TEST-DRAFT',
      reference: 'ENQ-TEST-DRAFT',
      status: 'Draft' as const,
      firstName: 'Gareth',
      lastName: 'Pritchard',
      privacyNoticeGiven: false,
      assignedTeamId: null,
      assignedToId: null,
    };

    const html = renderToStaticMarkup(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(EnquiryFormClient, {
          mode: 'draft',
          enquiry: draftWithNamesNoPrivacy,
          quotes: store.quotes,
          tasks: [],
          audit: [],
          people: store.people,
          organisations: store.organisations,
          matters: store.matters,
          enquiries: store.enquiries,
          teams: store.teams,
          values: store.values,
          orgStructure:
            store.orgStructure ??
            buildDefaultOrgStructure({ legalName: store.firm.name }),
          customFields: store.customFields,
          currentUserId: feeEarner.id,
          firmName: store.firm.name,
          tenantId: 'not-a-law-firm',
          initialErrors: {
            privacyNoticeGiven: 'Confirm privacy notice.',
            unmappedGate: 'Server routing gate rejected this enquiry.',
          },
        }),
      ),
    );

    // Caller badge must NOT claim "Complete" while privacyNoticeGiven is false
    expect(html).toContain('Privacy notice given');
    expect(html).toContain('enq-privacy-notice');
    expect(html).toContain('1 required');

    // Top-of-form unmapped server error banner renders unmapped key, not duplicated inline key
    expect(html).toContain('data-testid="enquiry-error-summary"');
    expect(html).toContain('Server routing gate rejected this enquiry.');
    const summaryStart = html.indexOf('data-testid="enquiry-error-summary"');
    const summaryEnd = html.indexOf('</section>', summaryStart);
    const summaryFragment =
      summaryStart >= 0
        ? html.slice(summaryStart, summaryEnd >= 0 ? summaryEnd + 10 : summaryStart + 600)
        : '';
    expect(summaryFragment).toContain('Server routing gate rejected this enquiry.');
    expect(summaryFragment).not.toContain('Confirm privacy notice.');
    expect(html).toContain('Confirm privacy notice.');
  });

  it('MatterFormClient displays unmapped server errors (extensions, riskAssessment) in a visible top-of-form summary', () => {
    const store = loadCommittedSeedStore();
    const feeEarner = store.people.find((p) => p.id === 'P-000002')!;

    const html = renderToStaticMarkup(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(MatterFormClient, {
          people: store.people,
          organisations: store.organisations,
          links: store.links,
          matters: store.matters,
          enquiries: store.enquiries,
          lists: store.lists,
          values: store.values,
          customFields: store.customFields,
          employees: store.people.filter((p) => p.isEmployee),
          currentUser: feeEarner,
          orgStructure:
            store.orgStructure ??
            buildDefaultOrgStructure({ legalName: store.firm.name }),
          matterCostsConfig: createDefaultMatterCostsConfig(store.values),
          tenantId: 'not-a-law-firm',
          initialServerSaveErrors: {
            extensions: "A required opening check couldn't run. Please contact your administrator.",
            riskAssessment: 'Invalid risk answer.',
          },
        }),
      ),
    );

    expect(html).toContain('data-testid="matter-error-summary"');
    expect(html).toContain(
      "A required opening check couldn&#x27;t run. Please contact your administrator.",
    );
    expect(html).toContain('Invalid risk answer.');
  });
});
