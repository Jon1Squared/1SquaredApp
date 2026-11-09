export interface CompaniesHouseAddress {
  line1: string;
  line2: string;
  town: string;
  county: string;
  postcode: string;
  country: string;
}

export interface CompaniesHouseCompanyRecord {
  companyNumber: string;
  companyName: string;
  companyStatus: 'Active' | 'Dissolved' | 'Liquidation';
  /** Maps to 1Squared organisation_type ChoiceValue label: 'Company', 'plc', 'LLP', 'Partnership', 'Non-profit' */
  organisationTypeLabel: 'Company' | 'plc' | 'LLP' | 'Partnership' | 'Non-profit';
  companyTypeDescription: string;
  incorporatedOn: string;
  registeredOfficeAddress: CompaniesHouseAddress;
  formerNames: string[];
  peopleWithSignificantControl: string[];
  directors: string[];
}

export const COMPANIES_HOUSE_NOT_CONFIGURED_MESSAGE =
  "Companies House lookup isn't set up";

export interface CompaniesHouseLookupResult {
  configured: boolean;
  records: CompaniesHouseCompanyRecord[];
  message?: string;
}

/**
 * Normalises Companies House "SURNAME, Forename Middle" format to "Forename Middle Surname"
 * when live API data is used.
 */
export function normaliseCompaniesHouseOfficerName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.includes(',')) return trimmed;
  const [surnamePart, restPart] = trimmed.split(',', 2);
  const surname = surnamePart
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const forenames = (restPart ?? '').trim();
  return [forenames, surname].filter(Boolean).join(' ');
}

/**
 * Looks up Companies House records when a live integration is configured.
 * Without a configured Companies House integration, returns an empty result and message
 * so the UI can prompt the user to enter company details manually.
 */
export function lookupCompaniesHouse(
  _query: string,
): CompaniesHouseLookupResult {
  return {
    configured: false,
    records: [],
    message: COMPANIES_HOUSE_NOT_CONFIGURED_MESSAGE,
  };
}
