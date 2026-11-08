import { describe, expect, it } from 'vitest';
import {
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
import { buildFieldResolutionContextForRecord } from '../documentGeneration';
import { buildSearchIndex } from '../searchIndex';
import type { Person } from '../types';

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

  it('buildFieldResolutionContextForRecord with empty firm settings leaves firm merge fields undefined rather than falling back to Pembroke Vaughan', () => {
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

    const { values: resolved } = resolveCatalogueValues(ctx, CORE_FIELD_CATALOGUE, {
      id: 'P-100100',
      tenantId: 'tenant-clean',
      roles: ['partner'],
    });
    expect(resolved['firm.registered_name']).toBeUndefined();
    expect(resolved['firm.trading_name']).toBeUndefined();
    expect(resolved['firm.regulator_number']).toBeUndefined();
    expect(resolved['firm.company_number']).toBeUndefined();
    expect(resolved['firm.vat_number']).toBeUndefined();
    expect(resolved['firm.head_office_address']).toBeUndefined();
    expect(resolved['firm.complaints_partner_name']).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain('Pembroke Vaughan');
  });
});
