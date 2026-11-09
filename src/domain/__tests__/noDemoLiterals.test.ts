import { describe, expect, it } from 'vitest';
import {
  BasicMergeEngine,
  buildValidDocxArchive,
  CORE_FIELD_CATALOGUE,
  resolveCatalogueValues,
} from '@platform/core';
import {
  buildDemoLiteralsDenyList,
  loadPmsDemoCodes,
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
import { buildSearchIndex } from '../searchIndex';
import type { Person } from '../types';

describe('S0-11a: demo literal CI guard and data-driven profile/domain helpers', () => {
  it('verifyNoDemoLiterals passes on the repository and scanTextForDemoLiterals catches planted demo literals unless allow-listed per file and per literal (R322, R346)', () => {
    expect(verifyNoDemoLiterals()).toEqual([]);

    const denyLiterals = buildDemoLiteralsDenyList();
    expect(denyLiterals).toContain('Not A Law Firm LLP');
    expect(denyLiterals).toContain('Pembroke Vaughan');

    const pmsCodes = loadPmsDemoCodes();
    expect(pmsCodes.has('PEN001')).toBe(true);
    expect(pmsCodes.has('BAY001')).toBe(true);
    expect(pmsCodes.has('SEV001')).toBe(true);
    expect(pmsCodes.has('FE005')).toBe(true);

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
      pmsCodes,
    );
    expect(violations).toHaveLength(3);
    expect(violations.map((v: { match: string }) => v.match)).toEqual([
      'Pembroke Vaughan',
      'P-000001',
      'Sanctions & PEP", value: "Clear"',
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
          literal: 'Sanctions & PEP", value: "Clear"',
          reason: 'Synthetic test allow-list entry for exact sanctions snippet',
        },
      ],
      pmsCodes,
    );
    expect(allowListed).toEqual([]);

    // R346 Bypass 1: bare PMS client codes (PEN001, BAY001, SEV002, SJO001) and fee-earner codes (FE005) fail
    const barePmsPlanted = [
      "const clientA = 'PEN001';",
      "const clientB = 'BAY001';",
      "const clientC = 'SEV002';",
      "const feeEarner = 'FE005';",
    ].join('\n');
    const barePmsViolations = scanTextForDemoLiterals(
      'src/components/SampleWidget.tsx',
      barePmsPlanted,
      denyLiterals,
      [],
      pmsCodes,
    );
    expect(barePmsViolations.map((v: { match: string }) => v.match)).toEqual([
      'PEN001',
      'BAY001',
      'SEV002',
      'FE005',
    ]);

    // R346 Bypass 2: allow-listing the first code on a line does NOT hide a second code on the same line
    const sameLinePlanted = [
      "const a = 'ABC123-0001', b = 'PEN001-0001';",
      "const p1 = 'P-000001', p2 = 'P-000002';",
      "const c1 = 'FE001', c2 = 'PEN001';",
    ].join('\n');
    const sameLineViolations = scanTextForDemoLiterals(
      'src/components/DocumentStoresAdminPanel.tsx',
      sameLinePlanted,
      denyLiterals,
      [
        {
          file: 'src/components/DocumentStoresAdminPanel.tsx',
          literal: 'ABC123-0001',
          reason: 'Allow-list first matter code only',
        },
        {
          file: 'src/components/DocumentStoresAdminPanel.tsx',
          literal: 'P-000001',
          reason: 'Allow-list first record ID only',
        },
        {
          file: 'src/components/DocumentStoresAdminPanel.tsx',
          literal: 'FE001',
          reason: 'Allow-list first PMS code only',
        },
      ],
      pmsCodes,
    );
    expect(sameLineViolations.map((v: { match: string }) => v.match)).toEqual([
      'PEN001-0001',
      'P-000002',
      'PEN001',
    ]);

    // R346 Bypass 3: generic 'Sanctions & PEP: Clear' allow-list key is rejected, and allow-listing one sanctions snippet does not exempt a second one in the same file
    const twoSanctionsInOneFile = [
      'export const a = <div><span>Sanctions &amp; PEP</span><span>Clear</span></div>;',
      'export const b = <div><span>PEP &amp; Sanctions</span><span>All clear</span></div>;',
    ].join('\n');
    const fileWideAttempt = scanTextForDemoLiterals(
      'src/components/PersonProfileClient.tsx',
      twoSanctionsInOneFile,
      denyLiterals,
      [
        {
          file: 'src/components/PersonProfileClient.tsx',
          literal: 'Sanctions & PEP: Clear',
          reason: 'Attempted file-wide exemption must not work',
        },
        {
          file: 'src/components/PersonProfileClient.tsx',
          literal: 'Sanctions &amp; PEP</span><span>Clear<',
          reason: 'Allow-list only the first snippet',
        },
      ],
      pmsCodes,
    );
    expect(fileWideAttempt).toHaveLength(1);
    expect(fileWideAttempt[0]?.match).toBe('PEP &amp; Sanctions</span><span>All clear<');

    // R346 Bypass 4: > Clear < with spaces, "All clear", lower case, "Sanctions and PEP" / "PEP & sanctions", and &nbsp; all fail
    const variantSanctions = [
      'export const v1 = <div><span>Sanctions & PEP</span><span> Clear </span></div>;',
      'export const v2 = <div><span>Sanctions and PEP</span><span>All clear</span></div>;',
      'export const v3 = <div><span>pep & sanctions</span><span>clear</span></div>;',
      'export const v4 = <div><span>PEP and Sanctions</span><span>&nbsp;All&nbsp;clear&nbsp;</span></div>;',
    ].join('\n');
    const variantViolations = scanTextForDemoLiterals(
      'src/components/PersonProfileClient.tsx',
      variantSanctions,
      denyLiterals,
      [],
      pmsCodes,
    );
    expect(variantViolations).toHaveLength(4);

    // R346 Bypass 5: placing the helper name AFTER the literal still fails
    const helperAfterLiteral =
      'export const view = () => { return <div><span>Sanctions &amp; PEP</span><span>Clear</span></div>; }; const _ = resolvePersonComplianceDisplay;';
    const helperAfterViolations = scanTextForDemoLiterals(
      'src/components/PersonProfileClient.tsx',
      helperAfterLiteral,
      denyLiterals,
      [],
      pmsCodes,
    );
    expect(helperAfterViolations).toHaveLength(1);
    expect(helperAfterViolations[0]?.match).toBe('Sanctions &amp; PEP</span><span>Clear<');

    // R322: '20\d\d-\d\d' in src/domain/pms.ts fails
    const pmsMonthViolations = scanTextForDemoLiterals(
      'src/domain/pms.ts',
      "const fixed = '2026-11';",
      denyLiterals,
      [],
      pmsCodes,
    );
    expect(pmsMonthViolations.some((v: { match: string }) => v.match === "'2026-11'")).toBe(true);

    // R363: Each separator/dash/suffix variant of fake Sanctions/PEP Clear is caught individually
    const r363Variants = [
      "const s1 = 'Sanctions/PEP: Clear';",
      "const s2 = 'Sanctions + PEP: Clear';",
      "const s3 = 'Sanctions & PEP — Clear';",
      "const s4 = 'Sanctions & PEP – Clear';",
      "const s5 = 'Sanctions & PEP - Clear';",
      "const s6 = 'Sanctions & PEP: Cleared';",
      "const s7 = 'Sanctions & PEP: Clear.';",
      "const s8 = 'Sanctions & PEP: Clear (no matches)';",
    ];
    for (const snippet of r363Variants) {
      const v = scanTextForDemoLiterals(
        'src/components/PersonProfileClient.tsx',
        snippet,
        denyLiterals,
        [],
        pmsCodes,
      );
      expect(v, `Expected violation for: ${snippet}`).toHaveLength(1);
    }

    // R363: 6-digit hex colour literals (#ABC123, #FFF000) and standard tokens (SHA256, AES256, RFC822, GBP123) are not flagged
    const nonDemoTokens = [
      "const hex1 = '#ABC123';",
      "const hex2 = '#FFF000';",
      "const algo1 = 'SHA256';",
      "const algo2 = 'AES256';",
      "const spec = 'RFC822';",
      "const curr = 'GBP123';",
    ].join('\n');
    expect(
      scanTextForDemoLiterals(
        'src/components/SampleWidget.tsx',
        nonDemoTokens,
        denyLiterals,
        [],
        pmsCodes,
      ),
    ).toEqual([]);
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
