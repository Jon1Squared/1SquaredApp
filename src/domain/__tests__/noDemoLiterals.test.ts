import { describe, expect, it } from 'vitest';
import {
  BasicMergeEngine,
  buildValidDocxArchive,
  CORE_FIELD_CATALOGUE,
  resolveCatalogueValues,
} from '@platform/core';
import {
  buildDemoLiteralsDenyList,
  scanTextForDemoLiterals,
  verifyNoDemoLiterals,
} from '../../../scripts/verify-no-demo-literals.mjs';
import { resolveMatterIntakeComplianceRows } from '../../components/MatterProfileClient';
import { resolveOrganisationComplianceDisplay } from '../../components/OrganisationProfileClient';
import { resolvePersonComplianceDisplay } from '../../components/PersonProfileClient';
import {
  COMPANIES_HOUSE_NOT_CONFIGURED_MESSAGE,
  lookupCompaniesHouse,
  normaliseCompaniesHouseOfficerName,
} from '../companiesHouse';
import { buildFieldResolutionContextForRecord } from '../documentGeneration';
import { computeEnquiryDashboardMetrics } from '../enquiries';
import { buildSearchIndex } from '../searchIndex';
import type { Enquiry, Person } from '../types';

describe('S0-11a: demo literal CI guard and data-driven profile/domain helpers', () => {
  it('verifyNoDemoLiterals passes on the repository and scanTextForDemoLiterals catches planted demo literals unless allow-listed', () => {
    expect(verifyNoDemoLiterals()).toEqual([]);

    const denyLiterals = buildDemoLiteralsDenyList();
    expect(denyLiterals).toContain('Not A Law Firm LLP');
    expect(denyLiterals).toContain('Pembroke Vaughan');

    const plantedSource = [
      'export const sampleFirm = "Pembroke Vaughan";',
      'export const sampleRecord = "P-000001";',
      'export const fakeSanctions = { label: "Sanctions & PEP", value: "Clear" };',
    ].join('\n');

    const violations = scanTextForDemoLiterals(
      'src/components/SampleWidget.tsx',
      plantedSource,
      denyLiterals,
      [],
    );
    expect(violations).toHaveLength(3);
    expect(violations.map((v: { match: string }) => v.match)).toEqual([
      'Pembroke Vaughan',
      'P-000001',
      'Sanctions & PEP: Clear',
    ]);

    const allowListed = scanTextForDemoLiterals(
      'src/components/SampleWidget.tsx',
      plantedSource,
      denyLiterals,
      [
        {
          file: 'src/components/SampleWidget.tsx',
          literal: 'Pembroke Vaughan',
          reason: 'Synthetic test allow-list entry for firm literal',
        },
        {
          file: 'src/components/SampleWidget.tsx',
          literal: 'P-000001',
          reason: 'Synthetic test allow-list entry for seed record ID',
        },
        {
          file: 'src/components/SampleWidget.tsx',
          literal: 'Sanctions & PEP: Clear',
          reason: 'Synthetic test allow-list entry for sanctions status',
        },
      ],
    );
    expect(allowListed).toEqual([]);

    // R322: real JSX form (Sanctions &amp; PEP ... >Clear<), PEN001-0001, FE005, and naming resolvePersonComplianceDisplay nearby all fail
    const jsxAndPmsPlanted = [
      'export const code = "PEN001-0001";',
      'export const fe = "FE005";',
      'export const view = () => { const _ = resolvePersonComplianceDisplay; return <div><span>Sanctions &amp; PEP</span><span>Clear</span></div>; };',
    ].join('\n');
    const r322Violations = scanTextForDemoLiterals(
      'src/components/PersonProfileClient.tsx',
      jsxAndPmsPlanted,
      denyLiterals,
      [],
    );
    expect(r322Violations.map((v: { match: string }) => v.match)).toContain('PEN001-0001');
    expect(r322Violations.map((v: { match: string }) => v.match)).toContain('FE005');
    expect(r322Violations.map((v: { match: string }) => v.match)).toContain(
      'Sanctions & PEP: Clear',
    );

    // R322: '20\d\d-\d\d' in src/domain/pms.ts fails
    const pmsMonthViolations = scanTextForDemoLiterals(
      'src/domain/pms.ts',
      "const fixed = '2026-11';",
      denyLiterals,
      [],
    );
    expect(pmsMonthViolations.some((v: { match: string }) => v.match === "'2026-11'")).toBe(true);
  });

  it('resolveMatterIntakeComplianceRows derives all four rows from stored matter fields including not-run conflict, not-started risk, and empty engagement letter status', () => {
    const emptyRows = resolveMatterIntakeComplianceRows(
      {
        conflictDecision: undefined,
        conflictCheckDate: '',
        amlCompletedAt: '',
        amlStatus: '',
        engagementLetterSignedAt: '',
        engagementLetterStatus: '',
      },
      {
        overallRisk: null,
        completedQuestions: 0,
        totalQuestions: 10,
      },
    );

    expect(emptyRows).toEqual({
      conflictCheck: {
        cleared: false,
        label: 'Conflict check not recorded',
        detail: '—',
      },
      clientDueDiligence: {
        verified: false,
        label: 'Client due diligence',
        detail: 'Not recorded',
      },
      engagementLetter: {
        signed: false,
        label: 'Engagement letter',
        detail: 'Not recorded',
      },
      riskAssessment: {
        completed: false,
        label: 'Matter risk assessment (Not started)',
        detail: '0/10 answered',
      },
    });

    const populatedRows = resolveMatterIntakeComplianceRows(
      {
        conflictDecision: {
          outcome: 'Cleared',
          decidedAt: '2026-10-12T09:00:00Z',
          decidedById: 'P-100100',
          decidedByName: 'Alex Example',
          sourceRecordId: 'M-100100',
          matchesCount: 0,
          searchedSources: ['people', 'organisations', 'matters'],
          summary: 'No conflicts found',
        },
        conflictCheckDate: '2026-10-12',
        amlCompletedAt: '2026-10-10T12:00:00Z',
        amlStatus: 'Verified',
        engagementLetterSignedAt: '2026-10-14T15:00:00Z',
        engagementLetterStatus: 'Signed',
      },
      {
        overallRisk: 'Low',
        completedQuestions: 10,
        totalQuestions: 10,
      },
    );

    expect(populatedRows.conflictCheck.cleared).toBe(true);
    expect(populatedRows.conflictCheck.label).toBe('Conflict check cleared');
    expect(populatedRows.clientDueDiligence.verified).toBe(true);
    expect(populatedRows.clientDueDiligence.detail).toContain('Verified');
    expect(populatedRows.engagementLetter.signed).toBe(true);
    expect(populatedRows.engagementLetter.label).toBe('Engagement letter signed');
    expect(populatedRows.riskAssessment.completed).toBe(true);
    expect(populatedRows.riskAssessment.label).toBe('Matter risk assessment (Low risk)');
    expect(populatedRows.riskAssessment.detail).toBe('10/10 answered');
  });

  it('resolvePersonComplianceDisplay and resolveOrganisationComplianceDisplay report Sanctions & PEP as "Not checked" and never "Clear"', () => {
    const personDisplay = resolvePersonComplianceDisplay(
      {
        verifiedAt: '2026-09-01',
        lastVerifiedAt: '2026-09-01',
      },
      'verified',
      null,
    );
    expect(personDisplay.sanctionsAndPep).toEqual({
      label: 'Not checked',
      pillClass: 'client-pill--neutral',
    });
    expect(personDisplay.sanctionsAndPep.label).not.toBe('Clear');

    const orgDisplay = resolveOrganisationComplianceDisplay(
      {
        lastVerifiedAt: '2026-09-15',
        reviewDate: '2027-09-15',
      },
      'verified',
    );
    expect(orgDisplay.sanctionsAndPep).toEqual({
      label: 'Not checked',
      tone: 'neutral',
    });
    expect(orgDisplay.sanctionsAndPep.label).not.toBe('Clear');
  });

  it('buildSearchIndex uses the configured firmName on employee subtitles instead of a hard-coded demo firm name', () => {
    const employee = {
      id: 'P-100100',
      recordType: 'person',
      firstName: 'Jordan',
      surname: 'Taylor',
      preferredName: '',
      otherNames: [],
      titleId: '',
      isClient: false,
      isParty: false,
      isContact: false,
      isEmployee: true,
      worksAtFirm: true,
      jobTitle: 'Solicitor',
      departmentId: '',
      officeId: '',
      employeeRoleId: '',
      relationshipRoleIds: [],
      emails: [{ address: 'jordan.taylor@example.com', label: 'Work', isPrimary: true }],
      phones: [],
      addresses: [],
      tags: [],
      notes: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      createdBy: 'system',
      updatedBy: 'system',
    } as unknown as Person;

    const entries = buildSearchIndex(
      [employee],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      'Acme Legal LLP',
    );
    const employeeEntry = entries.find((e) => e.id === 'P-100100');
    expect(employeeEntry).toBeDefined();
    expect(employeeEntry?.subtitle).toContain('Acme Legal LLP');
    expect(employeeEntry?.subtitle).not.toContain('Not A Law Firm');
  });

  it('buildFieldResolutionContextForRecord with empty firm settings leaves firm merge fields undefined rather than falling back to Pembroke Vaughan and reports them in missingRequiredFields', async () => {
    const ctx = buildFieldResolutionContextForRecord({
      tenantId: 'tenant-clean',
      people: [],
      organisations: [],
      values: [],
      firm: {},
    });

    expect(ctx.firm?.registeredName).toBe('');
    expect(ctx.firm?.tradingName).toBe('');
    expect(ctx.firm?.regulatorNumber).toBe('');
    expect(ctx.firm?.companyNumber).toBe('');
    expect(ctx.firm?.vatNumber).toBe('');
    expect(ctx.firm?.mainPhone).toBe('');
    expect(ctx.firm?.complaintsPartnerName).toBe('');
    expect(ctx.firm?.headOfficeAddress).toBeUndefined();

    const { values: resolved } = resolveCatalogueValues(
      ctx,
      CORE_FIELD_CATALOGUE,
      {
        id: 'P-100100',
        tenantId: 'tenant-clean',
        roles: ['partner'],
      },
    );
    expect(resolved['firm.registeredName']).toBeUndefined();
    expect(resolved['firm.tradingName']).toBeUndefined();
    expect(resolved['firm.regulatorNumber']).toBeUndefined();
    expect(resolved['firm.companyNumber']).toBeUndefined();
    expect(resolved['firm.vatNumber']).toBeUndefined();
    expect(resolved['firm.headOfficeAddress']).toBeUndefined();
    expect(resolved['firm.complaintsPartnerName']).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain('Pembroke Vaughan');

    const engine = new BasicMergeEngine();
    const docxBytes = buildValidDocxArchive({
      paragraphs: [
        { text: 'Firm: {{ firm.registeredName }}' },
        { text: 'Address: {{ firm.headOfficeAddress }}' },
        { text: 'Complaints Partner: {{ firm.complaintsPartnerName }}' },
      ],
    });
    const rendered = await engine.render({
      docxBytes,
      resolvedValues: resolved,
      mappings: {
        'firm.registeredName': {
          placeholder: 'firm.registeredName',
          sourceType: 'catalogue',
          catalogueKey: 'firm.registeredName',
          required: true,
        },
        'firm.headOfficeAddress': {
          placeholder: 'firm.headOfficeAddress',
          sourceType: 'catalogue',
          catalogueKey: 'firm.headOfficeAddress',
          required: true,
        },
        'firm.complaintsPartnerName': {
          placeholder: 'firm.complaintsPartnerName',
          sourceType: 'catalogue',
          catalogueKey: 'firm.complaintsPartnerName',
          required: true,
        },
      },
    });
    expect(rendered.missingRequiredFields).toEqual([
      'firm.registeredName',
      'firm.headOfficeAddress',
      'firm.complaintsPartnerName',
    ]);
  });

  it('computeEnquiryDashboardMetrics filters monthly enquiries by receivedAt, filters callbacks due today, and excludes uncontacted not-yet-due enquiries from SLA met % (R324)', () => {
    const baseEnq = (overrides: Partial<Enquiry>): Enquiry =>
      ({
        id: 'ENQ-1',
        reference: 'ENQ-1',
        receivedAt: '2026-11-05T10:00:00Z',
        takenById: 'P-1',
        channelId: 'enquiry_channel.phone',
        firstName: 'Alex',
        lastName: 'Morgan',
        callingOnBehalfOf: '',
        linkedOrganisationId: null,
        email: '',
        phone: '',
        preferredContactMethodId: null,
        bestTimeToCall: '',
        address: null,
        practiceAreaId: 'work_type.real_estate_and_property',
        workTypeSubcategoryId: null,
        summary: 'Test',
        notes: '',
        otherPartiesNamed: '',
        urgencyId: 'enquiry_urgency.standard',
        keyDate: null,
        keyDateLabel: '',
        sourceId: null,
        referrerPersonId: null,
        privacyNoticeGiven: true,
        linkedPersonId: null,
        assignedTeamId: null,
        assignedToId: 'P-1',
        status: 'Assigned',
        firstContactDueAt: '2026-11-10T17:30:00Z',
        nextActionDate: null,
        closeReasonId: null,
        referredToOrganisationId: null,
        convertedMatterId: null,
        contactLog: [],
        createdById: 'P-1',
        createdAt: '2026-11-05T10:00:00Z',
        updatedById: 'P-1',
        updatedAt: '2026-11-05T10:00:00Z',
        ...overrides,
      }) as Enquiry;

    const enquiries: Enquiry[] = [
      // 1. Oct enquiry (Converted) — excluded from Nov monthly counts; contacted within SLA
      baseEnq({
        id: 'ENQ-OCT',
        receivedAt: '2026-10-12T09:00:00Z',
        status: 'Converted',
        firstContactDueAt: '2026-10-12T17:30:00Z',
        contactLog: [
          {
            id: 'CL-1',
            at: '2026-10-12T11:00:00Z',
            byId: 'P-1',
            method: 'Call',
            outcome: 'Spoke',
            note: 'Spoke to client',
          },
        ],
      }),
      // 2. Nov enquiry due today (uncontacted, not yet overdue at 12:00) — excluded from SLA denominator
      baseEnq({
        id: 'ENQ-DUE-TODAY',
        receivedAt: '2026-11-09T09:00:00Z',
        status: 'Assigned',
        assignedToId: null,
        firstContactDueAt: '2026-11-09T17:30:00Z',
        contactLog: [],
      }),
      // 3. Nov enquiry overdue and uncontacted — counts in SLA denominator as missed
      baseEnq({
        id: 'ENQ-OVERDUE',
        receivedAt: '2026-11-04T09:00:00Z',
        status: 'Assigned',
        firstContactDueAt: '2026-11-05T17:30:00Z',
        contactLog: [],
      }),
      // 4. Nov enquiry converted and contacted on time — counts in Nov converted and SLA met
      baseEnq({
        id: 'ENQ-NOV-CONV',
        receivedAt: '2026-11-06T09:00:00Z',
        status: 'Converted',
        firstContactDueAt: '2026-11-06T17:30:00Z',
        contactLog: [
          {
            id: 'CL-2',
            at: '2026-11-06T10:30:00Z',
            byId: 'P-1',
            method: 'Call',
            outcome: 'Spoke',
            note: 'Converted',
          },
        ],
      }),
    ];

    const metrics = computeEnquiryDashboardMetrics(enquiries, '2026-11-09T12:00:00Z');
    expect(metrics.monthReceivedCount).toBe(3);
    expect(metrics.monthConvertedCount).toBe(1);
    expect(metrics.monthConversionPct).toBe(33);
    expect(metrics.monthOpenCount).toBe(2);
    expect(metrics.monthUnassignedCount).toBe(1);
    expect(metrics.callbacksDueTodayCount).toBe(1);
    expect(metrics.overdueCallbacksCount).toBe(1);
    // SLA evaluated over ENQ-OCT (met), ENQ-OVERDUE (missed), ENQ-NOV-CONV (met); ENQ-DUE-TODAY is not yet due and uncontacted so excluded
    expect(metrics.slaEvaluatedCount).toBe(3);
    expect(metrics.slaMetCount).toBe(2);
    expect(metrics.slaMetPct).toBe(67);
    expect(metrics.overdueSlaCount).toBe(1);
  });

  it('lookupCompaniesHouse returns unconfigured empty result without fabricated companies and normaliseCompaniesHouseOfficerName formats officer names (R335)', () => {
    const res = lookupCompaniesHouse('Pembroke');
    expect(res).toEqual({
      configured: false,
      records: [],
      message: COMPANIES_HOUSE_NOT_CONFIGURED_MESSAGE,
    });
    expect(normaliseCompaniesHouseOfficerName('MORGAN, Rhian Elin')).toBe(
      'Rhian Elin Morgan',
    );
  });
});
