/** Custom field definitions, screen locations, and validation against active definitions. */
import type {
  ChoiceValue,
  CustomFieldDefinition,
  CustomFieldRecordType,
  FormSection,
} from './types';

export interface CustomFieldValidation {
  values: Record<string, unknown>;
  errors: Record<string, string>;
}

export interface ScreenFieldLocationOption {
  value: FormSection;
  label: string;
  description: string;
}

export const CUSTOM_FIELD_SCREEN_OPTIONS: {
  recordType: CustomFieldRecordType;
  label: string;
  shortLabel: string;
}[] = [
  { recordType: 'enquiry', label: 'Enquiry screen', shortLabel: 'Enquiry' },
  { recordType: 'person', label: 'Person screen', shortLabel: 'Person' },
  { recordType: 'organisation', label: 'Organisation screen', shortLabel: 'Organisation' },
  { recordType: 'matter', label: 'Matter screen', shortLabel: 'Matter' },
  { recordType: 'quote', label: 'Quote screen', shortLabel: 'Quote' },
  { recordType: 'task', label: 'Task screen', shortLabel: 'Task' },
];

export const SCREEN_FIELD_LOCATIONS: Record<
  CustomFieldRecordType,
  ScreenFieldLocationOption[]
> = {
  enquiry: [
    {
      value: 'enquiry_caller',
      label: '1 · Caller',
      description: 'Placed in Section 1 alongside Channel, Name, On behalf of, and Source',
    },
    {
      value: 'enquiry_contact',
      label: '2 · Contact details',
      description: 'Placed in Section 2 alongside Phone, Email, Preferred contact, and Address',
    },
    {
      value: 'enquiry_details',
      label: '3 · The Enquiry',
      description: 'Placed in Section 3 alongside Practice area, Work type, Summary, and Notes',
    },
    {
      value: 'additional',
      label: '4 · Additional details (bottom section)',
      description: 'Placed in a dedicated Additional details section below Section 3',
    },
  ],
  person: [
    {
      value: 'A',
      label: 'Section A (Identity / Personal)',
      description: 'Personal and contact identity section',
    },
    {
      value: 'C',
      label: 'Section C (Relationship)',
      description: 'Relationship management and marketing section',
    },
    {
      value: 'D',
      label: 'Section D (Compliance)',
      description: 'Verification and compliance section',
    },
    {
      value: 'additional',
      label: 'Additional details (Custom fields tab)',
      description: 'Dedicated Custom fields tab on the Person screen',
    },
  ],
  organisation: [
    {
      value: 'A',
      label: 'Section A (Identity / Registration)',
      description: 'Organisation registration and address section',
    },
    {
      value: 'C',
      label: 'Section C (Relationship)',
      description: 'Relationship and business development section',
    },
    {
      value: 'D',
      label: 'Section D (Compliance & Billing)',
      description: 'Risk, onboarding, and billing section',
    },
    {
      value: 'additional',
      label: 'Additional details (Custom fields tab)',
      description: 'Dedicated Custom fields tab on the Organisation screen',
    },
  ],
  matter: [
    {
      value: 'matter_overview',
      label: 'Step 1 · Matter Overview & Classification',
      description: 'Placed in the Matter Overview step',
    },
    {
      value: 'matter_costs',
      label: 'Step 2 · Matter Costs',
      description: 'Placed in the Matter Costs step',
    },
    {
      value: 'matter_parties',
      label: 'Step 3 · Matter Parties',
      description: 'Placed in the Matter Parties step',
    },
    {
      value: 'additional',
      label: 'Additional details',
      description: 'Placed in the Additional details section',
    },
  ],
  quote: [
    {
      value: 'quote_client',
      label: 'Section 1 · Client & Enquiry Link',
      description: 'Placed in the Client details section',
    },
    {
      value: 'quote_scope',
      label: 'Section 2 · Work Type & Scope',
      description: 'Placed in the Work type and scope section',
    },
    {
      value: 'quote_fees',
      label: 'Section 3 · Fees & Follow-up',
      description: 'Placed in the Fees and validity section',
    },
    {
      value: 'additional',
      label: 'Additional details',
      description: 'Placed in the Additional details section',
    },
  ],
  task: [
    {
      value: 'task_details',
      label: 'Task details',
      description: 'Placed in the main Task details section',
    },
    {
      value: 'additional',
      label: 'Additional details',
      description: 'Placed in the Additional details section',
    },
  ],
};

export function getScreenFieldLocations(
  recordType: CustomFieldRecordType,
): ScreenFieldLocationOption[] {
  return SCREEN_FIELD_LOCATIONS[recordType] ?? SCREEN_FIELD_LOCATIONS.person;
}

export function getDefaultSectionForRecordType(
  recordType: CustomFieldRecordType,
): FormSection {
  if (recordType === 'enquiry') return 'enquiry_details';
  return 'additional';
}

export function formatSectionLocationLabel(
  recordType: CustomFieldRecordType,
  section: FormSection,
): string {
  const locations = getScreenFieldLocations(recordType);
  const matched = locations.find((l) => l.value === section);
  if (matched) return matched.label;
  return section;
}

export function activeDefinitions(
  defs: CustomFieldDefinition[],
  recordType: CustomFieldRecordType,
): CustomFieldDefinition[] {
  return defs
    .filter((d) => d.recordType === recordType && d.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export function activeDefinitionsForSection(
  defs: CustomFieldDefinition[],
  recordType: CustomFieldRecordType,
  section: FormSection,
): CustomFieldDefinition[] {
  return activeDefinitions(defs, recordType).filter((d) => d.section === section);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

export function isCustomFieldValueMissing(
  def: CustomFieldDefinition,
  raw: unknown,
): boolean {
  if (!def.required) return false;
  return isEmpty(raw);
}

/**
 * Validate and coerce submitted values.
 * - Values for inactive/unknown definitions already on the record are preserved untouched.
 * - Empty values are removed.
 */
export function validateCustomFields(
  defs: CustomFieldDefinition[],
  recordType: CustomFieldRecordType,
  submitted: Record<string, unknown>,
  existing: Record<string, unknown> = {},
  values: ChoiceValue[] = [],
): CustomFieldValidation {
  const active = activeDefinitions(defs, recordType);
  const activeIds = new Set(active.map((d) => d.id));
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  // Preserve data for definitions that are no longer active.
  for (const [k, v] of Object.entries(existing)) {
    if (!activeIds.has(k)) out[k] = v;
  }

  for (const def of active) {
    const raw = submitted[def.id];
    if (isEmpty(raw) || (def.fieldType === 'yesNo' && raw === '')) {
      if (def.required) errors[def.id] = `${def.label} is required`;
      continue;
    }
    switch (def.fieldType) {
      case 'text':
      case 'longText': {
        const s = String(raw).trim();
        if (def.fieldType === 'text' && s.length > 500)
          errors[def.id] = 'Too long (max 500 characters)';
        else out[def.id] = s;
        break;
      }
      case 'number': {
        const n =
          typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
        if (!Number.isFinite(n)) errors[def.id] = 'Enter a number';
        else out[def.id] = n;
        break;
      }
      case 'date': {
        const s = String(raw);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s).getTime()))
          errors[def.id] = 'Enter a valid date';
        else out[def.id] = s;
        break;
      }
      case 'yesNo': {
        const b = raw === true || raw === 'true' || raw === 'yes' || raw === 'on';
        const f = raw === false || raw === 'false' || raw === 'no';
        if (!b && !f) errors[def.id] = 'Choose yes or no';
        else out[def.id] = b;
        break;
      }
      case 'choice': {
        const id = String(raw);
        const v = values.find(
          (x) => x.id === id && x.listKey === def.optionsListKey,
        );
        const wasSelected = existing[def.id] === id;
        if (!v || (!v.active && !wasSelected))
          errors[def.id] = 'Choose a valid option';
        else out[def.id] = id;
        break;
      }
    }
  }
  return { values: out, errors };
}

export function formatCustomValue(
  def: CustomFieldDefinition,
  value: unknown,
  values: ChoiceValue[],
  formatDate: (s: string) => string,
): string {
  if (isEmpty(value)) return '';
  switch (def.fieldType) {
    case 'yesNo':
      return value === true ? 'Yes' : value === false ? 'No' : '';
    case 'date':
      return formatDate(String(value));
    case 'number':
      return Number(value).toLocaleString('en-GB');
    case 'choice':
      return values.find((v) => v.id === value)?.label ?? 'Unknown value';
    default:
      return String(value);
  }
}
