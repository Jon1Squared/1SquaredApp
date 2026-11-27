import { describe, expect, it } from 'vitest';
import { MAX_EMAIL_TOTAL_ATTACHMENT_BYTES, type DocumentPdfConverter } from '@platform/core';
import { createDefaultMatterCostsConfig, resolveMatterCostsSnapshot } from '@/domain/matterCosts';
import { buildQuotePdfDocxBytes, renderQuotePdfBytes } from '@/domain/quotePdf';
import {
  calculateQuoteTotals,
  roundCurrency,
  validateAndNormalizeQuotePoa,
} from '@/domain/quotes';
import type { ChoiceValue, Quote } from '@/domain/types';

const TEST_VALUES: ChoiceValue[] = [
  {
    id: 'work_type.residential_conveyancing',
    listKey: 'work_type',
    label: 'Residential conveyancing',
    sortOrder: 1,
    active: true,
  },
];

function makeBaseQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: 'Q-2026-099',
    reference: 'Q-2026-099',
    version: 1,
    status: 'Draft',
    clientType: 'prospect',
    linkedOrganisationId: null,
    linkedPersonId: null,
    prospectName: 'Harriet Shaw',
    prospectOrganisationName: '',
    prospectEmail: 'harriet.shaw@example.test',
    prospectPhone: '029 2000 0199',
    linkedEnquiryId: null,
    convertedMatterId: null,
    practiceAreaId: 'work_type.residential_conveyancing',
    workTypeSubcategoryId: null,
    scope: 'Freehold house purchase and title registration.',
    assumptions: 'Standard title with single mortgage charge.',
    feeBasis: 'Fixed fee',
    feeAmountExVat: 1500,
    hourlyRateGbp: null,
    vatRatePercent: 20,
    vatAmount: 300,
    vatOverridden: false,
    disbursements: [
      {
        id: 'd1',
        description: 'Local authority search',
        amountExVat: 250,
        vatApplicable: true,
      },
      {
        id: 'd2',
        description: 'Land Registry fee',
        amountExVat: 135,
        vatApplicable: false,
      },
    ],
    totalIncVat: 2235,
    paymentOnAccountRequired: true,
    paymentOnAccountPence: 75000,
    paymentOnAccountGbp: 750,
    feeEarnerId: 'P-000004',
    assignedTeamId: null,
    validUntil: '2026-12-31',
    followUpAfterDays: 7,
    sentAt: null,
    sentToEmail: null,
    sentByPersonId: null,
    lastSentOutboxId: null,
    priceTransparencySnapshot: {
      enabled: true,
      headlineSummary: 'Transparent residential purchase pricing.',
      serviceDescription: 'End-to-end conveyancing from instruction to registration.',
      keyStages: 'Searches -> Report -> Exchange -> Completion',
      typicalTimescales: '8 to 12 weeks',
      disbursementsGuidance: 'Official search and registration fees shown separately.',
      exclusionsAndVatNote: 'VAT charged at 20% on legal fees and taxable searches.',
      customNote: 'Includes Leasehold supplement review.',
    },
    nextFollowUpDate: null,
    outcomeAt: null,
    declineReason: null,
    followUps: [],
    versionHistory: [],
    timeline: [],
    createdById: 'P-000004',
    createdAt: '2026-11-27T09:00:00.000Z',
    updatedById: 'P-000004',
    updatedAt: '2026-11-27T09:00:00.000Z',
    ...overrides,
  };
}

describe('quotes domain & PDF generation (S1-07)', () => {
  it('validates Payment on Account in exact integer pence and clears nulls when not required', () => {
    expect(
      validateAndNormalizeQuotePoa({
        paymentOnAccountRequired: true,
        paymentOnAccountPence: 75050,
      }),
    ).toEqual({
      ok: true,
      paymentOnAccountRequired: true,
      paymentOnAccountPence: 75050,
      paymentOnAccountGbp: 750.5,
    });

    expect(
      validateAndNormalizeQuotePoa({
        paymentOnAccountRequired: true,
        paymentOnAccountGbp: '125.40',
      }),
    ).toEqual({
      ok: true,
      paymentOnAccountRequired: true,
      paymentOnAccountPence: 12540,
      paymentOnAccountGbp: 125.4,
    });

    expect(
      validateAndNormalizeQuotePoa({
        paymentOnAccountRequired: false,
        paymentOnAccountPence: 50000,
        paymentOnAccountGbp: 500,
      }),
    ).toEqual({
      ok: true,
      paymentOnAccountRequired: false,
      paymentOnAccountPence: null,
      paymentOnAccountGbp: null,
    });

    const missingAmount = validateAndNormalizeQuotePoa({
      paymentOnAccountRequired: true,
      paymentOnAccountGbp: 0,
    });
    expect(missingAmount.ok).toBe(false);

    const fractionalPence = validateAndNormalizeQuotePoa({
      paymentOnAccountRequired: true,
      paymentOnAccountPence: 123.4,
    });
    expect(fractionalPence.ok).toBe(false);

    const negative = validateAndNormalizeQuotePoa({
      paymentOnAccountRequired: true,
      paymentOnAccountPence: -100,
    });
    expect(negative.ok).toBe(false);
  });

  it('avoids floating-point drift in calculateQuoteTotals and roundCurrency', () => {
    expect(roundCurrency(0.1 + 0.2)).toBe(0.3);
    const totals = calculateQuoteTotals(
      10.1,
      null,
      [
        { id: 'd1', description: 'Copy A', amountExVat: 0.1, vatApplicable: true },
        { id: 'd2', description: 'Copy B', amountExVat: 0.2, vatApplicable: true },
      ],
      20,
    );
    expect(totals.feeAmountExVat).toBe(10.1);
    expect(totals.vatOnFee).toBe(2.02);
    expect(totals.disbursementsExVat).toBe(0.3);
    expect(totals.vatOnDisbursements).toBe(0.06);
    expect(totals.totalIncVat).toBe(12.48);
  });

  it('carries quote POA over into resolveMatterCostsSnapshot on conversion', () => {
    const config = createDefaultMatterCostsConfig(TEST_VALUES);
    const withPoa = resolveMatterCostsSnapshot({
      initialQuote: makeBaseQuote({
        paymentOnAccountRequired: true,
        paymentOnAccountPence: 82550,
        paymentOnAccountGbp: 825.5,
      }),
      config,
      values: TEST_VALUES,
    });
    expect(withPoa.paymentOnAccountRequired).toBe('Yes');
    expect(withPoa.paymentOnAccountAmountGbp).toBe(825.5);

    const withoutPoa = resolveMatterCostsSnapshot({
      initialQuote: makeBaseQuote({
        paymentOnAccountRequired: false,
        paymentOnAccountPence: null,
        paymentOnAccountGbp: null,
      }),
      config,
      values: TEST_VALUES,
    });
    expect(withoutPoa.paymentOnAccountRequired).toBe('No');
    expect(withoutPoa.paymentOnAccountAmountGbp).toBeNull();
  });

  it('renders Quote DOCX/PDF with POA + Price Transparency, enforces 3 MB attachment limit, and excludes CDD/AML strings (R812)', async () => {
    const quote = makeBaseQuote();
    const docxBytes = buildQuotePdfDocxBytes({
      quote,
      firmName: 'Pembroke Vaughan LLP',
      regulatorName: 'Solicitors Regulation Authority',
      regulatorNumber: '654321',
      contactEmail: 'quotes@example.test',
      feeEarnerName: 'Owain Pritchard',
      people: [],
      organisations: [],
      values: TEST_VALUES,
      priceTransparency: quote.priceTransparencySnapshot,
    });

    expect(docxBytes[0]).toBe(0x50); // 'P'
    expect(docxBytes[1]).toBe(0x4b); // 'K'
    const decodedText = Buffer.from(docxBytes).toString('utf8');
    expect(decodedText).toContain('Pembroke Vaughan LLP');
    expect(decodedText).toContain('Payment on Account requested before work begins');
    expect(decodedText).toContain('750.00');
    expect(decodedText).toContain('Price Transparency &amp; Service Information');
    expect(decodedText).toContain('Includes Leasehold supplement review.');
    expect(decodedText).not.toContain('amlStatus');
    expect(decodedText).not.toContain('amlCompletedAt');
    expect(decodedText).not.toContain('clientCddStatus');
    expect(decodedText).not.toContain('Sanctions');

    const okConverter: DocumentPdfConverter = {
      converterId: 'test-pdf-ok',
      async convertDocxToPdf() {
        return Buffer.from('%PDF-1.4\n% Quote PDF\n%%EOF\n');
      },
    };
    const okRes = await renderQuotePdfBytes({
      docxInput: {
        quote,
        firmName: 'Pembroke Vaughan LLP',
        feeEarnerName: 'Owain Pritchard',
        people: [],
        organisations: [],
        values: TEST_VALUES,
      },
      converter: okConverter,
      tenantId: 'tenant-test',
      correlationId: 'corr-1',
    });
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.fileName).toBe('Quote-Q-2026-099-v1.pdf');
      expect(Buffer.from(okRes.pdfBytes).toString('ascii')).toContain('%PDF-');
    }

    const oversizedConverter: DocumentPdfConverter = {
      converterId: 'test-pdf-too-big',
      async convertDocxToPdf() {
        return new Uint8Array(MAX_EMAIL_TOTAL_ATTACHMENT_BYTES + 1024);
      },
    };
    const bigRes = await renderQuotePdfBytes({
      docxInput: {
        quote,
        firmName: 'Pembroke Vaughan LLP',
        feeEarnerName: 'Owain Pritchard',
        people: [],
        organisations: [],
        values: TEST_VALUES,
      },
      converter: oversizedConverter,
      tenantId: 'tenant-test',
      correlationId: 'corr-2',
    });
    expect(bigRes.ok).toBe(false);
    if (!bigRes.ok) {
      expect(bigRes.code).toBe('EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED');
    }
  });

  it('rejects exponent-form, non-finite, and >2dp POA inputs strictly while preserving valid 2dp values (R862)', () => {
    for (const bad of [
      '1e3',
      '1E-2',
      1e-7,
      1e21,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '10.125',
      10.125,
      '500.001',
    ]) {
      const res = validateAndNormalizeQuotePoa({
        paymentOnAccountRequired: true,
        paymentOnAccountGbp: bad,
      });
      expect(res.ok, `Expected rejection for ${String(bad)}`).toBe(false);
    }

    for (const [inputVal, expectedPence, expectedGbp] of [
      ['500', 50000, 500],
      ['500.5', 50050, 500.5],
      ['500.50', 50050, 500.5],
      [0.01, 1, 0.01],
      [1234.56, 123456, 1234.56],
    ] as const) {
      const res = validateAndNormalizeQuotePoa({
        paymentOnAccountRequired: true,
        paymentOnAccountGbp: inputVal,
      });
      expect(res).toEqual({
        ok: true,
        paymentOnAccountRequired: true,
        paymentOnAccountPence: expectedPence,
        paymentOnAccountGbp: expectedGbp,
      });
    }
  });
});
