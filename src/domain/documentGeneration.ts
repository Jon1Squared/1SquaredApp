/**
 * Host Domain Bridge for Core Document Generation (`src/domain/documentGeneration.ts`).
 *
 * Connects the Next.js application entities (`Person`, `Organisation`, `Matter`, `FirmStore`)
 * to the `@platform/core` Document Generation engine, Field Catalogue, and RBAC permission resolvers.
 */

import type {
  DocumentGenerationConfig,
  DocumentLinkRecord,
  DocumentOutputFormat,
  DocumentPermission,
  DocumentTemplateRecord,
  DocumentTemplateVersionRecord,
  ExtractedPlaceholder,
  FieldCatalogueEntry,
  FieldGroup,
  FieldResolutionContext,
  GeneratedDocumentRecord,
  PlaceholderFilterName,
  PromptedFieldDefinition,
  PromptedFieldType,
  ScopedDownloadToken,
  StorageProviderId,
  TemplateAvailabilityRules,
  TemplatePackageManifest,
  TemplatePlaceholderMapping,
  TemplateStatus,
  TemplateUsageDailySummaryRecord,
  TemplateUsageEventRecord,
  TenantConfiguration,
} from '@platform/core-api';
import {
  DEFAULT_DOCUMENT_GENERATION_CONFIG,
  DEFAULT_DOCUMENT_PERMISSION_ROLES,
  approveTemplateVersion,
  buildAutoMappingsForPlaceholders,
  createOrUploadDraftTemplateVersion,
  findUnmappedPlaceholders,
  rejectTemplateVersion,
  retireTemplate,
  rollbackTemplateToVersion,
  submitTemplateVersionForApproval,
  updateDraftTemplateVersion,
  buildFullFieldCatalogueForTenant,
  CORE_FIELD_CATALOGUE,
  getReadableCatalogueFieldsForActor,
  resolveCatalogueValues,
  ALL_DOCUMENT_PERMISSIONS,
  canActorAccessGeneratedDocument,
  canActorAccessMatterRecord,
  hasDocumentPermission,
  normaliseActorHomeRoles,
  resolveDocumentPermissions,
  type DocumentPermissionActor,
  type MatterAccessSubject,
  type TemplateUsageReportFilter,
  type TemplateUsageReportResult,
} from '@platform/core';
import { resolveEmployeeRoles } from './homeConfig';
import { personDisplayName } from './names';
import type {
  Address,
  ChoiceValue,
  CustomFieldDefinition,
  Matter,
  Organisation,
  Person,
} from './types';

export function canActorViewUserLevelUsage(
  actor: DocumentPermissionActor,
  config: TenantConfiguration,
): boolean {
  return (
    config.documentGeneration.usage.showUserLevelDetail === true &&
    hasDocumentPermission(actor, 'document_template:view_usage_by_user', config)
  );
}

export function isTemplateAvailableInContext(params: {
  template: DocumentTemplateRecord;
  version?: DocumentTemplateVersionRecord | null;
  actor: DocumentPermissionActor;
  config: TenantConfiguration;
  sourceEntityType: 'matter' | 'client';
  practiceAreaKey?: string | null;
  matterTypeKey?: string | null;
  clientType?: 'Organisation' | 'Person' | null;
}): { available: boolean; reason?: string } {
  const {
    template,
    version,
    actor,
    config,
    sourceEntityType,
    practiceAreaKey,
    matterTypeKey,
    clientType,
  } = params;

  if (template.status !== 'Active' || !template.activeVersionId) {
    return { available: false, reason: 'Template is not currently Active.' };
  }

  const rules = template.availabilityRules;
  if (
    rules.sourceContexts?.length &&
    !rules.sourceContexts.includes(sourceEntityType)
  ) {
    return {
      available: false,
      reason: `Template is not available on ${sourceEntityType} records.`,
    };
  }

  if (
    sourceEntityType === 'matter' &&
    rules.practiceAreaKeys?.length &&
    practiceAreaKey &&
    !rules.practiceAreaKeys.includes(practiceAreaKey)
  ) {
    return {
      available: false,
      reason: 'Template is restricted to specific practice areas.',
    };
  }

  if (
    sourceEntityType === 'matter' &&
    rules.matterTypeKeys?.length &&
    matterTypeKey &&
    !rules.matterTypeKeys.includes(matterTypeKey)
  ) {
    return {
      available: false,
      reason: 'Template is restricted to specific matter types.',
    };
  }

  if (
    rules.clientTypes?.length &&
    clientType &&
    !rules.clientTypes.includes(clientType)
  ) {
    return {
      available: false,
      reason: `Template is restricted to ${rules.clientTypes.join('/')} clients.`,
    };
  }

  const actorRoles = new Set(normaliseActorHomeRoles(actor));
  if (rules.allowedRoleKeys?.length) {
    const hasRole = rules.allowedRoleKeys.some((r) => actorRoles.has(r));
    if (!hasRole) {
      return {
        available: false,
        reason: 'Actor role is not in the template’s allowed roles.',
      };
    }
  }

  if (version) {
    const usesFinancialField = Object.values(version.fieldMappings).some(
      (m) =>
        m.sourceType === 'catalogue' &&
        m.catalogueKey?.startsWith('financial.'),
    );
    if (
      usesFinancialField &&
      !hasDocumentPermission(actor, 'finance:view', config)
    ) {
      return {
        available: false,
        reason:
          'Template includes financial fields requiring "finance:view" permission.',
      };
    }
  }

  return { available: true };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Bytes(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const idx = (crc ^ bytes[i]!) & 0xff;
    crc = (CRC32_TABLE[idx]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Pure browser-and-server-safe OpenXML `.docx` generator using ZIP Store (method 0)
 * so client components can generate sample `.docx` files without importing `node:zlib` or `node:fs`.
 */
export function buildValidDocxArchive(options: {
  paragraphs?: Array<{
    text?: string;
    rawRunsXml?: string;
    heading?: 'Heading1' | 'Heading2';
    bold?: boolean;
  }>;
  tables?: Array<{
    headers: string[];
    rows: string[][];
  }>;
  headerText?: string;
  footerText?: string;
  isMacroEnabledContentType?: boolean;
  extraEntries?: Array<{ fileName: string; data: Uint8Array }>;
}): Uint8Array {
  const encoder = new TextEncoder();
  const mainContentType = options.isMacroEnabledContentType
    ? 'application/vnd.ms-word.document.macroEnabled.main+xml'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="${mainContentType}"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t xml:space="preserve">${escapeXml(options.headerText ?? '')}</w:t></w:r></w:p>
</w:hdr>`;

  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:r><w:t xml:space="preserve">${escapeXml(options.footerText ?? '')}</w:t></w:r></w:p>
</w:ftr>`;

  const bodyParts: string[] = [];
  for (const p of options.paragraphs ?? []) {
    const pPr = p.heading ? `<w:pPr><w:pStyle w:val="${p.heading}"/></w:pPr>` : '';
    if (p.rawRunsXml) {
      bodyParts.push(`<w:p>${pPr}${p.rawRunsXml}</w:p>`);
    } else {
      const rPr = p.bold ? '<w:rPr><w:b/></w:rPr>' : '';
      bodyParts.push(
        `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(p.text ?? '')}</w:t></w:r></w:p>`,
      );
    }
  }

  for (const tbl of options.tables ?? []) {
    const headerRow = `<w:tr>${tbl.headers
      .map(
        (h) =>
          `<w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(h)}</w:t></w:r></w:p></w:tc>`,
      )
      .join('')}</w:tr>`;
    const dataRows = tbl.rows
      .map(
        (r) =>
          `<w:tr>${r
            .map(
              (c) =>
                `<w:tc><w:p><w:r><w:t xml:space="preserve">${escapeXml(c)}</w:t></w:r></w:p></w:tc>`,
            )
            .join('')}</w:tr>`,
      )
      .join('');
    bodyParts.push(`<w:tbl>${headerRow}${dataRows}</w:tbl>`);
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyParts.join('\n    ')}
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rIdHeader1"/>
      <w:footerReference w:type="default" r:id="rIdFooter1"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const rawEntries: Array<{ fileName: string; data: Uint8Array }> = [
    { fileName: '[Content_Types].xml', data: encoder.encode(contentTypesXml) },
    { fileName: '_rels/.rels', data: encoder.encode(rootRelsXml) },
    { fileName: 'word/_rels/document.xml.rels', data: encoder.encode(docRelsXml) },
    { fileName: 'word/header1.xml', data: encoder.encode(headerXml) },
    { fileName: 'word/footer1.xml', data: encoder.encode(footerXml) },
    { fileName: 'word/document.xml', data: encoder.encode(documentXml) },
    ...(options.extraEntries ?? []),
  ];

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of rawEntries) {
    const nameBytes = encoder.encode(entry.fileName);
    const data = entry.data;
    const crc = crc32Bytes(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); // Store method 0
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, rawEntries.length, true);
  ev.setUint16(10, rawEntries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}

export {
  ALL_DOCUMENT_PERMISSIONS,
  approveTemplateVersion,
  buildAutoMappingsForPlaceholders,
  buildFullFieldCatalogueForTenant,
  canActorAccessGeneratedDocument,
  canActorAccessMatterRecord,
  CORE_FIELD_CATALOGUE,
  createOrUploadDraftTemplateVersion,
  DEFAULT_DOCUMENT_GENERATION_CONFIG,
  DEFAULT_DOCUMENT_PERMISSION_ROLES,
  findUnmappedPlaceholders,
  getReadableCatalogueFieldsForActor,
  hasDocumentPermission,
  rejectTemplateVersion,
  resolveCatalogueValues,
  resolveDocumentPermissions,
  retireTemplate,
  rollbackTemplateToVersion,
  submitTemplateVersionForApproval,
  updateDraftTemplateVersion,
  type DocumentGenerationConfig,
  type DocumentLinkRecord,
  type DocumentOutputFormat,
  type DocumentPermission,
  type DocumentPermissionActor,
  type DocumentTemplateRecord,
  type DocumentTemplateVersionRecord,
  type ExtractedPlaceholder,
  type FieldCatalogueEntry,
  type FieldGroup,
  type FieldResolutionContext,
  type GeneratedDocumentRecord,
  type MatterAccessSubject,
  type PlaceholderFilterName,
  type PromptedFieldDefinition,
  type PromptedFieldType,
  type ScopedDownloadToken,
  type StorageProviderId,
  type TemplateAvailabilityRules,
  type TemplatePackageManifest,
  type TemplatePlaceholderMapping,
  type TemplateStatus,
  type TemplateUsageDailySummaryRecord,
  type TemplateUsageEventRecord,
  type TemplateUsageReportFilter,
  type TemplateUsageReportResult,
};

/**
 * Converts a `Person` record into a `DocumentPermissionActor` using their full resolved `HomeRoleKey` set
 * (`resolveEmployeeRoles(user)`) plus any explicit `user.documentPermissions` overrides.
 * Never uses the UI's "Viewing as" role (`activeViewingRole`).
 */
export function buildDocumentActorFromPerson(
  user: Person | null | undefined,
): DocumentPermissionActor {
  if (!user) {
    return { id: '', roles: [] };
  }
  const fullRoles = resolveEmployeeRoles(user);
  return {
    id: user.id,
    roles: fullRoles,
    departmentId: user.departmentId ?? user.employment?.departmentId ?? null,
    permissionOverrides: user.permissionOverrides ?? null,
    documentPermissions: user.documentPermissions,
  };
}

export function resolvePersonDocumentPermissions(
  user: Person | null | undefined,
  config?:
    | Pick<TenantConfiguration, 'rbac' | 'documentGeneration'>
    | Pick<TenantConfiguration, 'documentGeneration'>
    | DocumentGenerationConfig
    | null,
): DocumentPermission[] {
  return resolveDocumentPermissions(buildDocumentActorFromPerson(user), config);
}

export function hasPersonDocumentPermission(
  user: Person | null | undefined,
  permission: DocumentPermission,
  config?:
    | Pick<TenantConfiguration, 'rbac' | 'documentGeneration'>
    | Pick<TenantConfiguration, 'documentGeneration'>
    | DocumentGenerationConfig
    | null,
): boolean {
  return hasDocumentPermission(
    buildDocumentActorFromPerson(user),
    permission,
    config,
  );
}

export function toMatterAccessSubject(
  matter: Matter | null | undefined,
): MatterAccessSubject | null {
  if (!matter) return null;
  return {
    id: matter.id,
    clientId: matter.clientId ?? undefined,
    isStaffMatter: Boolean(matter.isStaffMatter || matter.hasEthicalWall),
    restrictedAccessUserIds: matter.restrictedAccessUserIds ?? [],
    responsiblePartnerId: matter.responsiblePartnerId ?? undefined,
    responsibleSolicitorId:
      matter.leadFeeEarnerId ?? matter.responsiblePartnerId ?? undefined,
    originatingSolicitorId: matter.relationshipPartnerId ?? undefined,
    supervisingPartnerId: matter.supervisingPartnerId ?? undefined,
    leadFeeEarnerId: matter.leadFeeEarnerId ?? undefined,
    teamMemberIds: matter.teamMemberIds ?? [],
  };
}

function mapAddressToStructured(address: Address | null | undefined) {
  if (!address) return undefined;
  return {
    line1: address.line1 || '',
    line2: address.line2 || '',
    city: address.town || '',
    county: address.county || '',
    postcode: address.postcode || '',
    country: 'United Kingdom',
  };
}

function resolveChoiceLabel(
  values: readonly ChoiceValue[],
  id: string | null | undefined,
): string {
  if (!id) return '';
  return values.find((v) => v.id === id)?.label ?? id;
}

export interface PartyCandidateOption {
  id: string;
  entityType: 'organisation' | 'person';
  name: string;
  role: string;
  email: string;
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    county?: string;
    postcode?: string;
    country?: string;
  };
  salutation: string;
}

/**
 * Extracts available recipient and counterparty candidates linked to a Matter or Client
 * so the user can choose which party fills `party.recipient.*` and `party.counterparty.*`.
 */
export function listPartyCandidatesForRecord(params: {
  matter?: Matter | null;
  organisation?: Organisation | null;
  person?: Person | null;
  people: readonly Person[];
  organisations: readonly Organisation[];
  values: readonly ChoiceValue[];
}): PartyCandidateOption[] {
  const { matter, organisation, person, people, organisations, values } =
    params;
  const candidates: PartyCandidateOption[] = [];
  const seen = new Set<string>();

  const addOrg = (org: Organisation | undefined, role: string) => {
    if (!org || seen.has(org.id)) return;
    seen.add(org.id);
    candidates.push({
      id: org.id,
      entityType: 'organisation',
      name: org.legalName,
      role,
      email: org.generalEmail || '',
      address: mapAddressToStructured(
        org.correspondenceAddress ?? org.registeredAddress,
      ),
      salutation: 'Dear Sirs',
    });
  };

  const addPerson = (p: Person | undefined, role: string) => {
    if (!p || seen.has(p.id)) return;
    seen.add(p.id);
    const title = resolveChoiceLabel(values, p.titleId);
    const salutation =
      title && p.surname
        ? `Dear ${title} ${p.surname}`
        : `Dear ${personDisplayName(p)}`;
    candidates.push({
      id: p.id,
      entityType: 'person',
      name: personDisplayName(p),
      role,
      email: p.emails?.[0]?.address ?? '',
      address: mapAddressToStructured(p.addresses?.[0]),
      salutation,
    });
  };

  if (matter) {
    if (matter.clientId) {
      addOrg(
        organisations.find((o) => o.id === matter.clientId),
        'Primary Client',
      );
      addPerson(
        people.find((p) => p.id === matter.clientId),
        'Primary Client',
      );
    }
    if (matter.instructingContactId) {
      addPerson(
        people.find((p) => p.id === matter.instructingContactId),
        'Primary Contact',
      );
    }
    for (const party of matter.parties ?? []) {
      const roleLabel = party.role || 'Linked Party';
      if (party.entityType === 'organisation' && party.linkedRecordId) {
        addOrg(
          organisations.find((o) => o.id === party.linkedRecordId),
          roleLabel,
        );
      } else if (party.linkedRecordId) {
        addOrg(
          organisations.find((o) => o.id === party.linkedRecordId),
          roleLabel,
        );
        addPerson(people.find((p) => p.id === party.linkedRecordId), roleLabel);
      }
    }
  } else if (organisation) {
    addOrg(organisation, 'Primary Client');
  } else if (person) {
    addPerson(person, 'Primary Client');
  }

  return candidates;
}

/**
 * Builds the `FieldResolutionContext` for merging a template against a Matter, Organisation, or Person.
 */
export function buildFieldResolutionContextForRecord(params: {
  tenantId: string;
  matter?: Matter | null;
  organisation?: Organisation | null;
  person?: Person | null;
  currentUser?: Person | null;
  recipientPartyId?: string | null;
  counterpartyId?: string | null;
  promptedValues?: Record<string, unknown>;
  extensionFields?: Record<string, unknown>;
  people: readonly Person[];
  organisations: readonly Organisation[];
  values: readonly ChoiceValue[];
  firm?: {
    name?: string;
    legalName?: string;
    sraNumber?: string;
    companyNumber?: string;
    vatNumber?: string;
    phone?: string;
    email?: string;
    website?: string;
    address?: string;
  };
}): FieldResolutionContext {
  const {
    tenantId,
    matter,
    organisation,
    person,
    currentUser,
    people,
    organisations,
    values,
    firm,
  } = params;

  const clientOrg =
    organisation ??
    (matter?.clientId
      ? organisations.find((o) => o.id === matter.clientId)
      : undefined);
  const clientPerson =
    person ??
    (matter?.clientId
      ? people.find((p) => p.id === matter.clientId)
      : undefined);

  let clientData: Record<string, unknown> | null = null;
  if (clientOrg) {
    clientData = {
      id: clientOrg.id,
      reference: clientOrg.clientReference || clientOrg.id,
      name: clientOrg.legalName,
      legalName: clientOrg.legalName,
      type: 'Organisation',
      salutation: 'Dear Sirs',
      primaryEmail: clientOrg.generalEmail || '',
      primaryPhone: clientOrg.mainPhone || '',
      primaryAddress: mapAddressToStructured(
        clientOrg.correspondenceAddress ?? clientOrg.registeredAddress,
      ),
      registeredNumber: clientOrg.companyNumber || '',
      jurisdiction:
        resolveChoiceLabel(values, clientOrg.countryOfRegistrationId) ||
        'England and Wales',
      vatNumber: clientOrg.vatNumber || '',
      customFieldValues: clientOrg.customFields ?? {},
    };
  } else if (clientPerson) {
    const title = resolveChoiceLabel(values, clientPerson.titleId);
    const fullName = personDisplayName(clientPerson);
    clientData = {
      id: clientPerson.id,
      reference: clientPerson.id,
      name: fullName,
      type: 'Person',
      title,
      firstName: clientPerson.firstName,
      lastName: clientPerson.surname,
      salutation:
        title && clientPerson.surname
          ? `Dear ${title} ${clientPerson.surname}`
          : `Dear ${fullName}`,
      primaryEmail: clientPerson.emails?.[0]?.address ?? '',
      primaryPhone: clientPerson.phones?.[0]?.number ?? '',
      primaryAddress: mapAddressToStructured(clientPerson.addresses?.[0]),
      customFieldValues: clientPerson.customFields ?? {},
    };
  }

  const feeEarnerPerson = (matter?.leadFeeEarnerId || matter?.responsiblePartnerId)
    ? people.find((p) => p.id === (matter.leadFeeEarnerId || matter.responsiblePartnerId))
    : currentUser;
  const supervisorPerson = matter?.supervisingPartnerId
    ? people.find((p) => p.id === matter.supervisingPartnerId)
    : undefined;

  const feeEarnerData: Record<string, unknown> | null = feeEarnerPerson
    ? {
        fullName: personDisplayName(feeEarnerPerson),
        jobTitle:
          feeEarnerPerson.employment?.jobTitle ||
          feeEarnerPerson.jobTitle ||
          'Solicitor',
        workEmail:
          feeEarnerPerson.employment?.systems?.firmWorkEmail ||
          feeEarnerPerson.emails?.[0]?.address ||
          '',
        workPhone: feeEarnerPerson.phones?.[0]?.number || '',
        departmentName:
          resolveChoiceLabel(values, feeEarnerPerson.departmentId) ||
          'Legal Practice',
        officeName: 'London — Lincoln’s Inn Fields',
        officeAddress: {
          line1: '42 Lincoln’s Inn Fields',
          city: 'London',
          postcode: 'WC2A 3PE',
          country: 'United Kingdom',
        },
        supervisorName: supervisorPerson
          ? personDisplayName(supervisorPerson)
          : 'Victoria Pembroke',
        supervisorJobTitle:
          supervisorPerson?.employment?.jobTitle ||
          supervisorPerson?.jobTitle ||
          'Partner',
      }
    : null;

  const userData: Record<string, unknown> | null = currentUser
    ? {
        fullName: personDisplayName(currentUser),
        jobTitle:
          currentUser.employment?.jobTitle ||
          currentUser.jobTitle ||
          'Fee Earner',
        workEmail:
          currentUser.employment?.systems?.firmWorkEmail ||
          currentUser.emails?.[0]?.address ||
          '',
        workPhone: currentUser.phones?.[0]?.number || '',
        departmentName:
          resolveChoiceLabel(values, currentUser.departmentId) ||
          'Legal Practice',
        officeName: 'London — Lincoln’s Inn Fields',
      }
    : null;

  let matterData: Record<string, unknown> | null = null;
  let financialData: Record<string, unknown> | null = null;

  if (matter) {
    const practiceAreaLabel = resolveChoiceLabel(values, matter.practiceAreaId);
    const matterTypeLabel =
      resolveChoiceLabel(values, matter.workTypeSubcategoryId) ||
      practiceAreaLabel;
    const statusLabel = resolveChoiceLabel(values, matter.matterStatusId) || 'Open';
    const billingBasisLabel =
      resolveChoiceLabel(values, matter.billingBasisId) || 'Hourly Rates';

    matterData = {
      id: matter.id,
      reference: matter.matterNumber || matter.id,
      clientReference:
        (matter.fieldValues?.['CORE-050'] as string | undefined) || '',
      title: matter.title,
      description: matter.shortDescription || '',
      status: statusLabel,
      openDate: matter.openedAt || matter.createdAt.slice(0, 10),
      targetCompletionDate: matter.targetCompletionAt || '',
      closeDate: matter.closedAt || '',
      practiceArea: practiceAreaLabel,
      practiceAreaLabel,
      matterType: matterTypeLabel,
      matterTypeLabel,
      fundingType: billingBasisLabel,
      courtName:
        matter.forumCourt ||
        (matter.fieldValues?.['courtName'] as string | undefined) || '',
      caseNumber:
        (matter.fieldValues?.['caseNumber'] as string | undefined) || '',
      fieldValues: matter.fieldValues ?? {},
    };

    const costsSnapshot = matter.fieldValues?.['matterCostsSnapshot'] as
      | {
          totalEstimateGbp?: number | null;
          agreedCapGbp?: number | null;
          associateRateGbp?: number | null;
          partnerRateGbp?: number | null;
          disbursementsTotalGbp?: number | null;
          paymentOnAccountAmountGbp?: number | null;
        }
      | undefined;

    financialData = {
      feeEstimate:
        costsSnapshot?.totalEstimateGbp ?? matter.feeEstimateGbp ?? 0,
      agreedFeeCap:
        costsSnapshot?.agreedCapGbp ??
        matter.agreedFeeCapGbp ??
        matter.feeEstimateGbp ??
        0,
      hourlyRate:
        costsSnapshot?.associateRateGbp ??
        feeEarnerPerson?.employment?.feeEarner?.chargeOutRateGbp ??
        285,
      wipBalance:
        (matter.fieldValues?.['wipBalanceGbp'] as number | undefined) ?? 0,
      unbilledDisbursements: costsSnapshot?.disbursementsTotalGbp ?? 0,
      billedTotal:
        (matter.fieldValues?.['billedTotalGbp'] as number | undefined) ?? 0,
      unpaidInvoiceBalance:
        (matter.fieldValues?.['unpaidInvoiceBalanceGbp'] as
          | number
          | undefined) ?? 0,
      clientAccountBalance:
        (matter.fieldValues?.['clientAccountBalanceGbp'] as
          | number
          | undefined) ?? 0,
      officeAccountBalance:
        (matter.fieldValues?.['officeAccountBalanceGbp'] as
          | number
          | undefined) ?? 0,
      retainerAmount: costsSnapshot?.paymentOnAccountAmountGbp ?? 1500,
    };
  }

  const partyCandidates = listPartyCandidatesForRecord({
    matter,
    organisation,
    person,
    people,
    organisations,
    values,
  });

  const selectedRecipient =
    (params.recipientPartyId
      ? partyCandidates.find((c) => c.id === params.recipientPartyId)
      : undefined) ?? partyCandidates[0];

  const selectedCounterparty = params.counterpartyId
    ? partyCandidates.find((c) => c.id === params.counterpartyId)
    : partyCandidates.find((c) =>
        /counterparty|opponent|other side|defendant|seller|buyer/i.test(c.role),
      );

  const customFields: Record<string, unknown> = {
    ...(clientOrg?.customFields ?? {}),
    ...(clientPerson?.customFields ?? {}),
    ...(matter?.customFields ?? {}),
  };

  return {
    tenantId,
    nowIso: new Date().toISOString(),
    client: clientData,
    matter: matterData,
    financial: financialData,
    feeEarner: feeEarnerData,
    firm: {
      registeredName: firm?.legalName ?? firm?.name ?? 'Pembroke Vaughan LLP',
      tradingName: firm?.name ?? 'Pembroke Vaughan',
      regulatorName: 'Solicitors Regulation Authority',
      regulatorNumber: firm?.sraNumber ?? 'SRA-612048',
      companyNumber: firm?.companyNumber ?? 'OC391042',
      vatNumber: firm?.vatNumber ?? 'GB 942 1104 22',
      headOfficeAddress: {
        line1: '42 Lincoln’s Inn Fields',
        city: 'London',
        postcode: 'WC2A 3PE',
        country: 'United Kingdom',
      },
      mainPhone: firm?.phone ?? '+44 20 7946 0800',
      mainEmail: firm?.email ?? 'enquiries@pembrokevaughan.co.uk',
      website: firm?.website ?? 'www.pembrokevaughan.co.uk',
      complaintsPartnerName: 'Marcus Vaughan',
    },
    user: userData,
    recipientParty: selectedRecipient
      ? {
          name: selectedRecipient.name,
          salutation: selectedRecipient.salutation,
          role: selectedRecipient.role,
          reference: selectedRecipient.id,
          email: selectedRecipient.email,
          address: selectedRecipient.address,
        }
      : null,
    counterparty: selectedCounterparty
      ? {
          name: selectedCounterparty.name,
          address: selectedCounterparty.address,
        }
      : null,
    customFields,
    extensionFields: params.extensionFields ?? {},
    promptedValues: params.promptedValues ?? {},
  };
}

/**
 * Projects `CustomFieldDefinition[]` from `FirmStore` into `@platform/core` custom field catalogue entries.
 */
export function buildFullCatalogueFromStoreCustomFields(
  storeCustomFields: readonly CustomFieldDefinition[] = [],
): FieldCatalogueEntry[] {
  const mapped = storeCustomFields.map((cf) => ({
    id: cf.id,
    recordType:
      cf.recordType === 'organisation' ||
      cf.recordType === 'person' ||
      cf.recordType === 'matter'
        ? cf.recordType
        : ('matter' as const),
    label: cf.label,
    fieldType:
      cf.fieldType === 'number'
        ? ('number' as const)
        : cf.fieldType === 'date'
          ? ('date' as const)
          : cf.fieldType === 'yesNo'
            ? ('yesNo' as const)
            : ('text' as const),
    section: cf.section || 'additional',
    required: Boolean(cf.required),
    sortOrder: cf.sortOrder ?? 1,
    active: cf.active !== false,
  }));
  return buildFullFieldCatalogueForTenant({ customFields: mapped });
}

/**
 * Generates the binary `.docx` bytes for the pre-seeded **Client Care & Engagement Letter**
 * template using canonical Field Catalogue placeholders.
 */
export function buildSeedClientCareTemplateDocxBytes(): Uint8Array {
  return buildValidDocxArchive({
    headerText: '{{ firm.registeredName }} | Our Ref: {{ matter.reference }}',
    footerText:
      '{{ firm.registeredName }} is authorised and regulated by the {{ firm.regulatorName }} (No. {{ firm.regulatorNumber }}).',
    paragraphs: [
      {
        text: '{{ firm.registeredName }}',
        heading: 'Heading1',
        bold: true,
      },
      {
        text: '{{ date.today | date:"d MMMM yyyy" }}',
      },
      {
        text: 'PRIVATE & CONFIDENTIAL',
        bold: true,
      },
      {
        text: '{{ party.recipient.name }}',
      },
      {
        text: '{{ party.recipient.address | address_multi }}',
      },
      {
        text: 'Our Ref: {{ matter.reference }}',
        bold: true,
      },
      {
        text: '{{ party.recipient.salutation }},',
      },
      {
        text: 'Client Care & Engagement Letter: {{ matter.title }}',
        heading: 'Heading2',
        bold: true,
      },
      {
        text: 'Thank you for instructing {{ firm.registeredName }} to act for {{ client.name }} in connection with {{ matter.title }} ({{ matter.practiceArea }} — {{ matter.matterType }}). This letter sets out the basis on which we will carry out our work and our key regulatory terms of engagement.',
      },
      {
        text: '1. Scope of Instructions & Objectives',
        heading: 'Heading2',
        bold: true,
      },
      {
        text: '{{ matter.description }}',
      },
      {
        text: 'Special Instructions / Key Assumptions: {{ prompted.specialScopeNotes }}',
      },
      {
        text: '2. People Responsible for Your Matter',
        heading: 'Heading2',
        bold: true,
      },
      {
        text: 'Day-to-day conduct of your matter will be handled by {{ feeEarner.fullName }} ({{ feeEarner.jobTitle }}), who can be contacted directly at {{ feeEarner.workEmail }} or {{ feeEarner.workPhone }}. Overall supervision of the matter is the responsibility of {{ feeEarner.supervisorName }}.',
      },
      {
        text: '3. Charges, Fee Estimate & Payment on Account',
        heading: 'Heading2',
        bold: true,
      },
      {
        text: 'Your matter will be billed on a {{ matter.fundingType }} basis. Our current estimate of professional charges is {{ financial.feeEstimate | currency }} ({{ financial.feeEstimate | words }}) plus VAT and disbursements. The applicable lead hourly charge-out rate is {{ financial.hourlyRate | currency }} per hour plus VAT. To enable us to commence work promptly, please arrange payment on account of {{ financial.retainerAmount | currency }}.',
      },
      {
        text: '4. Client Identification, Regulatory & Complaints Procedure',
        heading: 'Heading2',
        bold: true,
      },
      {
        text: 'Under anti-money laundering regulations we are required to verify the identity of all clients before acting. If you ever have any concern about our service, please raise it in the first instance with {{ feeEarner.fullName }} or {{ feeEarner.supervisorName }}, or contact our Complaints Partner, {{ firm.complaintsPartnerName }}, at {{ firm.mainEmail }}.',
      },
      {
        text: 'Please sign and return a copy of this letter to confirm your agreement to these terms.',
      },
      {
        text: 'Yours faithfully,',
      },
      {
        text: '{{ feeEarner.fullName }} ({{ feeEarner.jobTitle }})',
        bold: true,
      },
      {
        text: 'For and on behalf of {{ firm.registeredName }}',
      },
    ],
  });
}

/**
 * Generates the binary `.docx` bytes for a second seeded template:
 * **Client General Correspondence Letter** (accessible to all roles without requiring `finance:view`).
 */
export function buildSeedGeneralCorrespondenceDocxBytes(): Uint8Array {
  return buildValidDocxArchive({
    headerText: '{{ firm.registeredName }} | Ref: {{ matter.reference }}',
    footerText:
      '{{ firm.registeredName }} | {{ firm.headOfficeAddress | address_single }} | {{ firm.mainPhone }}',
    paragraphs: [
      {
        text: '{{ firm.registeredName }}',
        heading: 'Heading1',
        bold: true,
      },
      {
        text: '{{ date.today | date:"d MMMM yyyy" }}',
      },
      {
        text: '{{ party.recipient.name }}',
      },
      {
        text: '{{ party.recipient.address | address_multi }}',
      },
      {
        text: 'Our Ref: {{ matter.reference }}',
        bold: true,
      },
      {
        text: '{{ party.recipient.salutation }},',
      },
      {
        text: 'Re: {{ matter.title }}',
        heading: 'Heading2',
        bold: true,
      },
      {
        text: '{{ prompted.letterBody }}',
      },
      {
        text: 'If you have any questions regarding the above, please contact {{ feeEarner.fullName }} at {{ feeEarner.workEmail }} or on {{ feeEarner.workPhone }}.',
      },
      {
        text: 'Yours sincerely,',
      },
      {
        text: '{{ user.fullName }}',
        bold: true,
      },
      {
        text: '{{ user.jobTitle }} — {{ firm.registeredName }}',
      },
    ],
  });
}
