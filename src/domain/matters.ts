/**
 * Matter & Engagement Field Model engine (Pillar 2).
 * Driven by src/seed/data/matterFieldModel.json (extracted from Matter_Engagement_Field_Model.xlsx)
 * and aligned with taxonomy.json.
 */
import rawModel from '@/seed/data/matterFieldModel.json';
import { resolveLabel, valuesForList } from './lists';
import type { KeyDate } from './keyDates.types';
import type { ChoiceValue, Matter, Organisation, Person, PersonOrganisationLink } from './types';

export type RequiredLevel =
  | 'Opening'
  | 'Stage 2'
  | 'Stage 3'
  | 'Stage 4'
  | 'Stage 5'
  | 'Stage 6'
  | 'Closure'
  | 'Conditional'
  | 'Optional';

export interface MatterModelField {
  id: string;
  section?: string;
  groupId?: string;
  groupName?: string;
  practiceArea?: string;
  subcategory?: string;
  typeBadge?: string;
  label: string;
  /** Alias for label used in UI components */
  name: string;
  description?: string;
  fieldType: string;
  /** Alias for fieldType used in UI components */
  dataType: string;
  valuesSource: string;
  required: RequiredLevel | string;
  criticalDate: boolean;
  notes: string;
}

export interface MatterFieldGroup {
  id: string;
  /** Alias for id (e.g. 'FG01') */
  code: string;
  name: string;
  description: string;
  fields: MatterModelField[];
}

export interface SubcategoryMatrixItem {
  index: number;
  /** Derived subcategory code (e.g. 'RE01', 'CC03', 'PC01', 'M01') */
  code: string;
  practiceArea: string;
  subcategory: string;
  typeBadge: string;
  defaultMatterType: string;
  typicalBillingBasis: string;
  fieldGroups: string[];
  /** Alias for fieldGroups */
  fieldGroupCodes: string[];
  specificFieldCount: number;
  totalFieldCount: number;
  /** Alias for totalFieldCount */
  totalFields: number;
}

export interface MatterFieldModelCatalogue {
  coreFields: MatterModelField[];
  fieldGroups: MatterFieldGroup[];
  matrix: SubcategoryMatrixItem[];
  /** Alias for matrix */
  subcategoryMatrix: SubcategoryMatrixItem[];
  subcategoryFields: MatterModelField[];
}

const GROUP_DESCRIPTIONS: Record<string, string> = {
  FG01: 'Consideration, deposit, completion mechanisms, conditions precedent, exchange and completion dates.',
  FG02: 'Court/tribunal details, claim number, track, counsel, limitation date, procedural timetable, trial window and costs budgets.',
  FG03: 'Property address, registered/unregistered title numbers, tenure, use class, EPC and property search status.',
  FG04: 'Agreement type, contracting parties, effective/expiry dates, term, break/renewal dates, liability cap and value.',
  FG05: 'Lender/security trustee, facility type, facility amount, interest/margin, maturity date, security package and Companies House 21-day registration deadline.',
  FG06: 'Lead regulator, reference number, trigger event, notification/response deadlines, outcome and undertakings.',
  FG07: 'Employee job title, continuous employment start/termination dates, salary, notice period, restrictive covenants and ACAS conciliation.',
  FG08: 'Date of birth, domicile/tax residence, marital status, mental capacity assessment, vulnerability adjustments and translators.',
  FG09: 'Target/subject entity legal name, company number, entity type, jurisdiction of incorporation and registered office.',
};

function normalizeField(raw: Record<string, unknown>): MatterModelField {
  const label = String(raw.label ?? raw.name ?? '');
  const fieldType = String(raw.fieldType ?? raw.dataType ?? 'Text');
  return {
    id: String(raw.id ?? ''),
    section: raw.section ? String(raw.section) : undefined,
    groupId: raw.groupId ? String(raw.groupId) : undefined,
    groupName: raw.groupName ? String(raw.groupName) : undefined,
    practiceArea: raw.practiceArea ? String(raw.practiceArea) : undefined,
    subcategory: raw.subcategory ? String(raw.subcategory) : undefined,
    typeBadge: raw.typeBadge ? String(raw.typeBadge) : undefined,
    label,
    name: label,
    description: raw.description ? String(raw.description) : undefined,
    fieldType,
    dataType: fieldType,
    valuesSource: String(raw.valuesSource ?? ''),
    required: String(raw.required ?? 'Optional'),
    criticalDate: Boolean(raw.criticalDate),
    notes: String(raw.notes ?? ''),
  };
}

function buildModel(): MatterFieldModelCatalogue {
  const raw = rawModel as {
    coreFields: Record<string, unknown>[];
    fieldGroups: { id: string; name: string; fields: Record<string, unknown>[] }[];
    matrix: {
      index: number;
      practiceArea: string;
      subcategory: string;
      typeBadge: string;
      defaultMatterType: string;
      typicalBillingBasis: string;
      fieldGroups: string[];
      specificFieldCount: number;
      totalFieldCount: number;
    }[];
    subcategoryFields: Record<string, unknown>[];
  };

  const coreFields = raw.coreFields.map(normalizeField);
  const subcategoryFields = raw.subcategoryFields.map(normalizeField);
  const fieldGroups: MatterFieldGroup[] = raw.fieldGroups.map((g) => ({
    id: g.id,
    code: g.id,
    name: `${g.id} — ${g.name}`,
    description: GROUP_DESCRIPTIONS[g.id] ?? g.name,
    fields: g.fields.map(normalizeField),
  }));

  const matrix: SubcategoryMatrixItem[] = raw.matrix.map((m) => {
    const firstSpecific = subcategoryFields.find(
      (f) => (f.subcategory ?? '').trim().toLowerCase() === m.subcategory.trim().toLowerCase(),
    );
    const derivedCode = firstSpecific ? firstSpecific.id.split('-')[0] : `M${String(m.index).padStart(2, '0')}`;
    return {
      ...m,
      code: derivedCode,
      fieldGroupCodes: m.fieldGroups,
      totalFields: m.totalFieldCount,
    };
  });

  return {
    coreFields,
    fieldGroups,
    matrix,
    subcategoryMatrix: matrix,
    subcategoryFields,
  };
}

export const MATTER_FIELD_MODEL: MatterFieldModelCatalogue = buildModel();

export const CORE_SECTIONS = [
  'Identification',
  'Classification',
  'People',
  'Parties & Conflicts',
  'Compliance & Onboarding',
  'Financial',
  'Lifecycle',
  'Knowledge & Marketing',
] as const;

export type CoreSectionName = (typeof CORE_SECTIONS)[number];

/** Look up the SubcategoryMatrixItem by subcategory label, code, or ChoiceValue id. */
export function findSubcategoryRule(
  subcategoryLabelOrId: string | null | undefined,
  values?: ChoiceValue[],
): SubcategoryMatrixItem | undefined {
  if (!subcategoryLabelOrId) return undefined;
  const resolved = values ? resolveLabel(values, subcategoryLabelOrId) || subcategoryLabelOrId : subcategoryLabelOrId;
  const norm = String(resolved).trim().toLowerCase();
  return MATTER_FIELD_MODEL.matrix.find(
    (m) => m.subcategory.trim().toLowerCase() === norm || m.code.toLowerCase() === norm,
  );
}

/** Return the active Field Groups (FG01..FG09) that apply to a subcategory. */
export function fieldGroupsForSubcategory(
  subcategoryLabelOrId: string | null | undefined,
  values?: ChoiceValue[],
): MatterFieldGroup[] {
  const rule = findSubcategoryRule(subcategoryLabelOrId, values);
  if (!rule) return [];
  const activeSet = new Set(rule.fieldGroups);
  return MATTER_FIELD_MODEL.fieldGroups.filter((g) => activeSet.has(g.id));
}

/** Return the Subcategory-Specific Fields (Layer 3) that apply to a subcategory. */
export function specificFieldsForSubcategory(
  subcategoryLabelOrId: string | null | undefined,
  values?: ChoiceValue[],
): MatterModelField[] {
  const rule = findSubcategoryRule(subcategoryLabelOrId, values);
  if (!rule) return [];
  const norm = rule.subcategory.trim().toLowerCase();
  return MATTER_FIELD_MODEL.subcategoryFields.filter(
    (f) => (f.subcategory ?? '').trim().toLowerCase() === norm,
  );
}

/** Return all Core Fields grouped by their section. */
export function coreFieldsBySection(): { section: CoreSectionName; fields: MatterModelField[] }[] {
  return CORE_SECTIONS.map((sec) => ({
    section: sec,
    fields: MATTER_FIELD_MODEL.coreFields.filter((f) => f.section === sec),
  }));
}

/** Determine the numeric stage index (1..7) from a Matter Stage label or id. */
export function stageNumberFrom(
  stageLabelOrId: string | null | undefined,
  values?: ChoiceValue[],
): number {
  if (!stageLabelOrId) return 1;
  const label = values ? resolveLabel(values, stageLabelOrId) || stageLabelOrId : stageLabelOrId;
  const m = String(label).match(/Stage\s*(\d+)/i) || String(label).match(/^(\d+)\./);
  return m ? Number(m[1]) : 1;
}

/**
 * Check if a field's `required` level is currently mandatory given the matter's lifecycle stage
 * and status.
 */
export function isFieldRequiredAtStage(
  requiredLevel: string,
  currentStageNumber: number,
  matterStatus?: string,
): boolean {
  if (requiredLevel === 'Opening') return true;
  const stageMatch = requiredLevel.match(/^Stage\s*(\d+)$/i);
  if (stageMatch) {
    return currentStageNumber >= Number(stageMatch[1]);
  }
  if (requiredLevel === 'Closure') {
    return currentStageNumber >= 7 || matterStatus?.toLowerCase() === 'closed';
  }
  return false;
}

/**
 * Parse inline slash-separated picklist options from a field's `valuesSource`,
 * or resolve options from a taxonomy ChoiceList when `valuesSource` references an Axis.
 */
export function resolveFieldOptions(
  field: MatterModelField,
  values: ChoiceValue[],
  context?: {
    practiceAreaId?: string | null;
    jurisdictionGroupId?: string | null;
    stageId?: string | null;
  },
): { id: string; label: string; badge?: string }[] {
  const src = field.valuesSource.trim();

  // CORE-008 Matter status
  if (field.id === 'CORE-008') {
    return valuesForList(values, 'matter_status')
      .filter((v) => v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // CORE-009 Practice Area (Axis 1 level 1)
  if (field.id === 'CORE-009' || src.includes('Axis 1 — Practice Area')) {
    return valuesForList(values, 'work_type')
      .filter((v) => !v.parentId && v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // CORE-010 Work type subcategory (Axis 1 level 2)
  if (field.id === 'CORE-010' || src.includes('Axis 1 — Subcategory')) {
    const allSubs = valuesForList(values, 'work_type').filter((v) => v.parentId && v.active);
    const filtered = context?.practiceAreaId
      ? allSubs.filter((v) => v.parentId === context.practiceAreaId)
      : allSubs;
    return filtered.map((v) => ({ id: v.id, label: v.label, badge: v.meta?.badge }));
  }

  // Axis 2 — Document Type
  if (src.includes('Axis 2 — Document Type')) {
    return valuesForList(values, 'document_type')
      .filter((v) => v.parentId && v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // Axis 3 — Matter Type
  if (src.includes('Axis 3 — Matter Type')) {
    return valuesForList(values, 'matter_type')
      .filter((v) => v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // Axis 3 — Billing Basis
  if (src.includes('Axis 3 — Billing Basis')) {
    return valuesForList(values, 'billing_basis')
      .filter((v) => v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // Axis 3 — Risk Rating
  if (src.includes('Axis 3 — Risk Rating')) {
    return valuesForList(values, 'risk_rating')
      .filter((v) => v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // Axis 3 — Matter Size
  if (src.includes('Axis 3 — Matter Size')) {
    return valuesForList(values, 'matter_size')
      .filter((v) => v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // Axis 4 — Jurisdiction Group (level 1)
  if (field.id === 'CORE-018' || src.includes('Axis 4 — Jurisdiction Group')) {
    return valuesForList(values, 'jurisdiction')
      .filter((v) => !v.parentId && v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // Axis 4 — Jurisdiction / System (level 2)
  if (src.includes('Axis 4 — Jurisdiction / System')) {
    const allSys = valuesForList(values, 'jurisdiction').filter((v) => v.parentId && v.active);
    const filtered =
      field.id === 'CORE-019' && context?.jurisdictionGroupId
        ? allSys.filter((v) => v.parentId === context.jurisdictionGroupId)
        : allSys;
    return filtered.map((v) => ({ id: v.id, label: v.label }));
  }

  // Axis 5 — Stage 1–7
  if (field.id === 'CORE-060' || src.includes('Axis 5 — Stage')) {
    return valuesForList(values, 'matter_stage')
      .filter((v) => !v.parentId && v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // Axis 5 — Milestone / Task (dependent on stage)
  if (field.id === 'CORE-061' || src.includes('Axis 5 — Milestone')) {
    const allMilestones = valuesForList(values, 'matter_stage').filter((v) => v.parentId && v.active);
    const filtered = context?.stageId
      ? allMilestones.filter((v) => v.parentId === context.stageId)
      : allMilestones;
    return filtered.map((v) => ({
      id: v.id,
      label: v.meta?.code ? `${v.meta.code} ${v.label}` : v.label,
    }));
  }

  // Axis 7 — Referrer / Source Type
  if (src.includes('Axis 7 — Referrer / Source Type')) {
    return valuesForList(values, 'origin')
      .filter((v) => v.active)
      .map((v) => ({ id: v.id, label: v.label }));
  }

  // Country list
  if (src.toLowerCase().includes('country list')) {
    return valuesForList(values, 'country')
      .filter((v) => v.active)
      .map((v) => ({ id: v.label, label: v.label }));
  }

  // Inline slash-separated values
  if (src.includes('/')) {
    const cleaned = src.replace(/^Role:\s*/i, '');
    return cleaned
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((opt) => ({ id: opt, label: opt }));
  }

  return [];
}

/**
 * Extract all populated Critical Dates on a matter (from Core fields, active Field Groups, and Subcategory fields).
 */
export function extractCriticalDates(
  matter: Matter,
  subcategoryLabel?: string,
  matterKeyDates?: readonly KeyDate[],
): { fieldId: string; label: string; date: string }[] {
  const out: { fieldId: string; label: string; date: string }[] = [];
  if (Array.isArray(matterKeyDates)) {
    for (const kd of matterKeyDates) {
      if (
        kd.matterId === matter.id &&
        kd.status !== 'superseded' &&
        kd.status !== 'waived'
      ) {
        out.push({
          fieldId: kd.id,
          label: `${kd.title} (${kd.status})`,
          date: kd.dueDate,
        });
      }
    }
  }
  if (matter.targetCompletionAt) {
    out.push({
      fieldId: 'CORE-059',
      label: 'Target completion / key date',
      date: matter.targetCompletionAt,
    });
  }
  if (matter.destructionDueAt) {
    out.push({
      fieldId: 'CORE-063',
      label: 'File destruction due date',
      date: matter.destructionDueAt,
    });
  }

  const subcat = subcategoryLabel ?? '';
  const groups = fieldGroupsForSubcategory(subcat);
  const specifics = specificFieldsForSubcategory(subcat);
  const dynamicMap = new Map<string, MatterModelField>();
  for (const f of [...groups.flatMap((g) => g.fields), ...specifics]) {
    if (f.criticalDate) dynamicMap.set(f.id, f);
  }
  if (matter.fieldValues) {
    for (const f of [
      ...MATTER_FIELD_MODEL.fieldGroups.flatMap((g) => g.fields),
      ...MATTER_FIELD_MODEL.subcategoryFields,
    ]) {
      if (f.criticalDate && matter.fieldValues[f.id] !== undefined) {
        dynamicMap.set(f.id, f);
      }
    }
  }
  const allDynamic = Array.from(dynamicMap.values());

  for (const f of allDynamic) {
    if (!f.criticalDate) continue;
    const raw = matter.fieldValues?.[f.id];
    if (!raw) continue;
    let dateStr: string | null = null;
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
      dateStr = raw.trim();
    } else if (typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as { primary?: unknown; secondary?: unknown; date?: unknown };
      for (const candidate of [obj.primary, obj.secondary, obj.date]) {
        if (typeof candidate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate.trim())) {
          dateStr = candidate.trim();
          break;
        }
      }
    }
    if (dateStr) {
      out.push({
        fieldId: f.id,
        label: f.name,
        date: dateStr,
      });
    }
  }

  const customDates = matter.fieldValues?.['customKeyDates'];
  if (Array.isArray(customDates)) {
    for (const item of customDates) {
      if (item && typeof item === 'object') {
        const entry = item as { id?: unknown; label?: unknown; date?: unknown };
        const dStr = typeof entry.date === 'string' ? entry.date.trim() : '';
        const lbl = typeof entry.label === 'string' ? entry.label.trim() : '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(dStr)) {
          out.push({
            fieldId: typeof entry.id === 'string' && entry.id ? entry.id : `RISK-DATE-${dStr}`,
            label: lbl || 'Imminent deadline / key date',
            date: dStr,
          });
        }
      }
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Resolve inherited client attributes (Client Tier, Sector, Relationship Partner, Instructing & Billing Contacts)
 * when a Person or Organisation is selected as the Client on a matter.
 */
export function deriveClientAttributes(
  clientId: string | null | undefined,
  people: Person[],
  organisations: Organisation[],
  links: PersonOrganisationLink[],
  values?: ChoiceValue[],
): {
  clientRecord: Person | Organisation | null;
  clientTierId: string | null;
  clientSectorId: string | null;
  relationshipPartnerId: string | null;
  instructingContactId: string | null;
  billingContactId: string | null;
} {
  if (!clientId) {
    return {
      clientRecord: null,
      clientTierId: null,
      clientSectorId: null,
      relationshipPartnerId: null,
      instructingContactId: null,
      billingContactId: null,
    };
  }

  const org = organisations.find((o) => o.id === clientId);
  if (org) {
    const orgLinks = links.filter((l) => l.organisationId === org.id && l.isCurrent);
    const primaryLink = orgLinks.find((l) => l.isPrimaryContact) ?? orgLinks[0];
    const billingLink =
      orgLinks.find((l) =>
        l.contactRoleIds.some((rid) => rid.includes('billing') || (values && resolveLabel(values, rid) === 'Billing')),
      ) ?? primaryLink;

    return {
      clientRecord: org,
      clientTierId: org.clientTierId,
      clientSectorId: org.sectorId,
      relationshipPartnerId: org.relationshipPartnerId,
      instructingContactId: primaryLink?.personId ?? null,
      billingContactId: billingLink?.personId ?? primaryLink?.personId ?? null,
    };
  }

  const person = people.find((p) => p.id === clientId);
  if (person) {
    const privTier = values?.find((v) => v.listKey === 'client_tier' && v.label.includes('Private'))?.id ?? null;
    const privSector = values?.find((v) => v.listKey === 'sector' && v.label.includes('Private'))?.id ?? null;
    return {
      clientRecord: person,
      clientTierId: privTier,
      clientSectorId: privSector,
      relationshipPartnerId: person.relationshipOwnerId,
      instructingContactId: person.id,
      billingContactId: person.id,
    };
  }

  return {
    clientRecord: null,
    clientTierId: null,
    clientSectorId: null,
    relationshipPartnerId: null,
    instructingContactId: null,
    billingContactId: null,
  };
}
