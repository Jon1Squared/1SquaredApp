/**
 * Quote DOCX & PDF generation helpers (`S1-07`).
 *
 * Pure integer minor-unit calculations and document assembly; PDF conversion
 * runs strictly outside any database transaction via `selectDocumentPdfConverter`.
 * Never reads or embeds matter CDD/AML outcomes (`R812`).
 */
import {
  calculateVatMinorUnits,
  formatMinorUnitsGbp,
  MAX_EMAIL_TOTAL_ATTACHMENT_BYTES,
  percentToBasisPoints,
  poundsToMinorUnits,
  sumMinorUnits,
  type DocumentPdfConverter,
  type MinorUnits,
} from '@platform/core';
import { buildValidDocxArchive } from './documentGeneration';
import { quoteClientDisplayName, quoteWorkTypeSummary } from './quotes';
import type {
  ChoiceValue,
  Organisation,
  Person,
  Quote,
  QuotePriceTransparencySnapshot,
} from './types';

function toSafeMinorUnits(value: number | null | undefined): MinorUnits {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const raw = String(num);
  return poundsToMinorUnits(/[eE]/.test(raw) ? num.toFixed(4) : raw);
}

export interface BuildQuotePdfDocxInput {
  readonly quote: Quote;
  readonly firmName: string;
  readonly regulatorName?: string | null;
  readonly regulatorNumber?: string | null;
  readonly contactEmail?: string | null;
  readonly feeEarnerName: string;
  readonly people: Person[];
  readonly organisations: Organisation[];
  readonly values: ChoiceValue[];
  readonly priceTransparency?: QuotePriceTransparencySnapshot | null;
}

/**
 * Generates an OpenXML `.docx` representation of the quote ready for conversion
 * to PDF via `selectDocumentPdfConverter`.
 */
export function buildQuotePdfDocxBytes(input: BuildQuotePdfDocxInput): Uint8Array {
  const { quote } = input;
  const firmName = input.firmName.trim() || 'Law Firm';
  const vatRatePercent =
    typeof quote.vatRatePercent === 'number' && Number.isFinite(quote.vatRatePercent)
      ? quote.vatRatePercent
      : 20;
  const vatBps = percentToBasisPoints(vatRatePercent);
  const feeExMinor = toSafeMinorUnits(quote.feeAmountExVat);
  const feeVatMinor = Number.isFinite(Number(quote.vatAmount))
    ? toSafeMinorUnits(quote.vatAmount)
    : calculateVatMinorUnits(feeExMinor, vatBps);

  const disbRows: Array<{
    readonly description: string;
    readonly exMinor: MinorUnits;
    readonly vatMinor: MinorUnits;
    readonly incMinor: MinorUnits;
  }> = [];

  for (const d of quote.disbursements ?? []) {
    const exMinor = toSafeMinorUnits(d.amountExVat);
    const vatMinor =
      d.vatOverridden && d.vatAmount !== undefined && d.vatAmount !== null
        ? toSafeMinorUnits(d.vatAmount)
        : d.vatApplicable
          ? calculateVatMinorUnits(exMinor, vatBps)
          : 0;
    const incMinor = sumMinorUnits([exMinor, vatMinor]);
    disbRows.push({
      description: d.description?.trim() || 'Disbursement',
      exMinor,
      vatMinor,
      incMinor,
    });
  }

  const disbExTotalMinor = sumMinorUnits(disbRows.map((d) => d.exMinor));
  const disbVatTotalMinor = sumMinorUnits(disbRows.map((d) => d.vatMinor));
  const totalExMinor = sumMinorUnits([feeExMinor, disbExTotalMinor]);
  const totalVatMinor = sumMinorUnits([feeVatMinor, disbVatTotalMinor]);
  const totalIncMinor = sumMinorUnits([totalExMinor, totalVatMinor]);

  const poaPence: MinorUnits =
    quote.paymentOnAccountRequired &&
    typeof quote.paymentOnAccountPence === 'number' &&
    Number.isSafeInteger(quote.paymentOnAccountPence) &&
    quote.paymentOnAccountPence > 0
      ? quote.paymentOnAccountPence
      : quote.paymentOnAccountRequired &&
          typeof quote.paymentOnAccountGbp === 'number' &&
          quote.paymentOnAccountGbp > 0
        ? toSafeMinorUnits(quote.paymentOnAccountGbp)
        : 0;

  const clientDisplay = quoteClientDisplayName(
    quote,
    input.people,
    input.organisations,
  );
  const workTypeSummary = quoteWorkTypeSummary(quote, input.values);
  const transparency =
    input.priceTransparency ?? quote.priceTransparencySnapshot ?? null;

  const regulatorFooter =
    input.regulatorName && input.regulatorNumber
      ? `${firmName} | Authorised and regulated by ${input.regulatorName} (${input.regulatorNumber})`
      : input.contactEmail
        ? `${firmName} | ${input.contactEmail}`
        : firmName;

  const paragraphs: Array<{
    text: string;
    heading?: 'Heading1' | 'Heading2';
    bold?: boolean;
  }> = [
    {
      text: firmName,
      heading: 'Heading1',
      bold: true,
    },
    {
      text: `Fee Quote & Costs Information — ${quote.reference} (Version ${quote.version})`,
      heading: 'Heading2',
      bold: true,
    },
    {
      text: `Prepared for: ${clientDisplay}`,
    },
    {
      text: `Work type: ${workTypeSummary}`,
    },
    {
      text: `Fee basis: ${quote.feeBasis}${quote.hourlyRateGbp ? ` (Lead rate ${formatMinorUnitsGbp(toSafeMinorUnits(quote.hourlyRateGbp))}/hr plus VAT)` : ''}`,
    },
    {
      text: `Prepared by: ${input.feeEarnerName}`,
    },
    {
      text: quote.validUntil
        ? `Valid until: ${quote.validUntil}`
        : 'Valid for 30 days from issue unless withdrawn earlier.',
    },
    {
      text: '1. Scope of Work & Assumptions',
      heading: 'Heading2',
      bold: true,
    },
    {
      text: quote.scope.trim() || 'Legal services as instructed.',
    },
  ];

  if (quote.assumptions?.trim()) {
    paragraphs.push({
      text: `Assumptions & Key Dependencies: ${quote.assumptions.trim()}`,
    });
  }

  paragraphs.push({
    text: '2. Summary of Professional Fees, Disbursements & VAT',
    heading: 'Heading2',
    bold: true,
  });

  if (poaPence > 0) {
    paragraphs.push({
      text: `Payment on Account requested before work begins: ${formatMinorUnitsGbp(poaPence)} (held in client account in accordance with client money rules).`,
      bold: true,
    });
  }

  if (transparency?.enabled) {
    paragraphs.push({
      text: '3. Price Transparency & Service Information',
      heading: 'Heading2',
      bold: true,
    });
    const sections: Array<[string, string | undefined]> = [
      ['Overview', transparency.headlineSummary],
      ['What our service includes', transparency.serviceDescription],
      ['Key stages', transparency.keyStages],
      ['Typical timescales', transparency.typicalTimescales],
      ['Disbursements guidance', transparency.disbursementsGuidance],
      ['VAT & exclusions', transparency.exclusionsAndVatNote],
      ['Matter-specific note', transparency.customNote],
    ];
    for (const [heading, body] of sections) {
      if (body?.trim()) {
        paragraphs.push({
          text: `${heading}: ${body.trim()}`,
        });
      }
    }
  }

  const feeIncMinor = sumMinorUnits([feeExMinor, feeVatMinor]);
  const tableRows: string[][] = [
    [
      `Professional fees (${quote.feeBasis})`,
      formatMinorUnitsGbp(feeExMinor),
      `${formatMinorUnitsGbp(feeVatMinor)} (${vatRatePercent}%)`,
      formatMinorUnitsGbp(feeIncMinor),
    ],
    ...disbRows.map((d) => [
      `Disbursement: ${d.description}`,
      formatMinorUnitsGbp(d.exMinor),
      formatMinorUnitsGbp(d.vatMinor),
      formatMinorUnitsGbp(d.incMinor),
    ]),
    [
      'Total Quote',
      formatMinorUnitsGbp(totalExMinor),
      formatMinorUnitsGbp(totalVatMinor),
      formatMinorUnitsGbp(totalIncMinor),
    ],
  ];
  if (poaPence > 0) {
    tableRows.push([
      'Payment on Account (requested on instruction)',
      '—',
      '—',
      formatMinorUnitsGbp(poaPence),
    ]);
  }

  return buildValidDocxArchive({
    headerText: `${firmName} | Quote ${quote.reference} (v${quote.version})`,
    footerText: regulatorFooter,
    paragraphs,
    tables: [
      {
        headers: ['Item', 'Amount (ex VAT)', 'VAT', 'Total (inc VAT)'],
        rows: tableRows,
      },
    ],
  });
}

export async function renderQuotePdfBytes(params: {
  readonly docxInput: BuildQuotePdfDocxInput;
  readonly converter: DocumentPdfConverter;
  readonly tenantId: string;
  readonly correlationId: string;
}): Promise<
  | { readonly ok: true; readonly pdfBytes: Uint8Array; readonly fileName: string }
  | { readonly ok: false; readonly code: 'EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED'; readonly error: string }
> {
  const docxBytes = buildQuotePdfDocxBytes(params.docxInput);
  const { quote } = params.docxInput;
  const safeRef = (quote.reference || quote.id).replace(/[^A-Za-z0-9._-]+/g, '-');
  const fileName = `Quote-${safeRef}-v${quote.version}.pdf`;
  const pdfBytes = await params.converter.convertDocxToPdf({
    docxBytes,
    title: `Quote ${quote.reference} (v${quote.version})`,
    authorName: params.docxInput.feeEarnerName || params.docxInput.firmName,
    tenantId: params.tenantId,
    correlationId: params.correlationId,
  });

  if (pdfBytes.byteLength > MAX_EMAIL_TOTAL_ATTACHMENT_BYTES) {
    return {
      ok: false,
      code: 'EMAIL_ATTACHMENT_SIZE_LIMIT_EXCEEDED',
      error:
        'The generated quote PDF exceeds the 3 MB email attachment limit. Remove large text notes or download and split the document before sending.',
    };
  }

  return { ok: true, pdfBytes, fileName };
}
