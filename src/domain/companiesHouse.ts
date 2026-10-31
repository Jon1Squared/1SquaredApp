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

export const DEMO_COMPANIES_HOUSE_RECORDS: CompaniesHouseCompanyRecord[] = [
  {
    companyNumber: '08451290',
    companyName: 'Cambrian Maritime & Logistics Ltd',
    companyStatus: 'Active',
    organisationTypeLabel: 'Company',
    companyTypeDescription: 'Private limited company (Ltd)',
    incorporatedOn: '2013-03-18',
    registeredOfficeAddress: {
      line1: 'Baltic House, Mount Stuart Square',
      line2: 'Cardiff Bay',
      town: 'Cardiff',
      county: 'South Glamorgan',
      postcode: 'CF10 5FH',
      country: 'Wales',
    },
    formerNames: ['Cambrian Freight Forwarding Ltd', 'Cardiff Bay Haulage Ltd'],
    peopleWithSignificantControl: [
      'Gareth Owen Pritchard (75% or more shares)',
      'Cambrian Holdings Group Ltd',
    ],
    directors: [
      'Gareth Owen Pritchard',
      'Eleri Mai Davies',
      'Marcus John Vance',
    ],
  },
  {
    companyNumber: '04477120',
    companyName: 'Severn Estuary Holdings plc',
    companyStatus: 'Active',
    organisationTypeLabel: 'plc',
    companyTypeDescription: 'Public limited company (PLC)',
    incorporatedOn: '2002-07-04',
    registeredOfficeAddress: {
      line1: 'Severn House, 1 Temple Quay',
      line2: '',
      town: 'Bristol',
      county: 'Bristol',
      postcode: 'BS1 6DZ',
      country: 'England',
    },
    formerNames: ['Severn Estuary Industrial Group plc'],
    peopleWithSignificantControl: [
      'Alistair Sterling (25% to 50% shares)',
      'Western Pension Trustees Ltd (25% to 50% shares)',
    ],
    directors: [
      'Alistair Sterling',
      'Harriet Louise Vance',
      'DavidArthur Jenkins',
    ],
  },
  {
    companyNumber: 'OC419204',
    companyName: 'Brecon Capital Partners LLP',
    companyStatus: 'Active',
    organisationTypeLabel: 'LLP',
    companyTypeDescription: 'Limited liability partnership (LLP)',
    incorporatedOn: '2017-09-22',
    registeredOfficeAddress: {
      line1: '14 Cathedral Road',
      line2: 'Pontcanna',
      town: 'Cardiff',
      county: 'South Glamorgan',
      postcode: 'CF11 9LJ',
      country: 'Wales',
    },
    formerNames: ['Brecon Advisory LLP'],
    peopleWithSignificantControl: [
      'Rhodri Wyn Evans (25% to 50% voting rights)',
      'Catrin Haf Morgan (25% to 50% voting rights)',
    ],
    directors: [
      'Rhodri Wyn Evans',
      'Catrin Haf Morgan',
      'Simon Paul Henderson',
    ],
  },
  {
    companyNumber: '11209483',
    companyName: 'Gower Renewable Energy Developments Ltd',
    companyStatus: 'Active',
    organisationTypeLabel: 'Company',
    companyTypeDescription: 'Private limited company (Ltd)',
    incorporatedOn: '2018-02-16',
    registeredOfficeAddress: {
      line1: 'Suite 4, Technium Swansea',
      line2: 'Kings Road, SA1 Waterfront',
      town: 'Swansea',
      county: 'West Glamorgan',
      postcode: 'SA1 8PH',
      country: 'Wales',
    },
    formerNames: ['Gower Wind & Solar Ltd'],
    peopleWithSignificantControl: [
      'Dr Nia Seren Thomas (50% to 75% shares)',
      'Celtic Clean Tech Ventures Ltd (25% to 50% shares)',
    ],
    directors: [
      'Dr Nia Seren Thomas',
      'Owain Rhys Bowen',
    ],
  },
  {
    companyNumber: '09638105',
    companyName: 'Clifton Fine Properties & Estates Ltd',
    companyStatus: 'Active',
    organisationTypeLabel: 'Company',
    companyTypeDescription: 'Private limited company (Ltd)',
    incorporatedOn: '2015-06-12',
    registeredOfficeAddress: {
      line1: '28 Queen Square',
      line2: '',
      town: 'Bristol',
      county: 'Bristol',
      postcode: 'BS1 4ND',
      country: 'England',
    },
    formerNames: [
      'Clifton Residential Developments Ltd',
      'Avon Gorge Estates Ltd',
    ],
    peopleWithSignificantControl: [
      'Julian Charles Thornton (75% or more shares)',
    ],
    directors: [
      'Julian Charles Thornton',
      'ソフィア・ソーントン (Sophia Thornton)',
      'Edward James Thornton',
    ],
  },
  {
    companyNumber: '10542891',
    companyName: 'Valleys Community Housing Trust',
    companyStatus: 'Active',
    organisationTypeLabel: 'Non-profit',
    companyTypeDescription: 'Private company limited by guarantee without share capital',
    incorporatedOn: '2016-12-01',
    registeredOfficeAddress: {
      line1: 'Ty Cynon, Navigation Park',
      line2: 'Abercynon',
      town: 'Mountain Ash',
      county: 'Rhondda Cynon Taf',
      postcode: 'CF45 4SN',
      country: 'Wales',
    },
    formerNames: ['Cynon Valley Homes Association'],
    peopleWithSignificantControl: [
      'Megan Ruth Lewis (Right to appoint or remove directors)',
    ],
    directors: [
      'Megan Ruth Lewis',
      'Huw Glynne Williams',
      'Sian Elizabeth Powell',
    ],
  },
  {
    companyNumber: '12894011',
    companyName: 'Taff Vale Construction & Civil Engineering Ltd',
    companyStatus: 'Active',
    organisationTypeLabel: 'Company',
    companyTypeDescription: 'Private limited company (Ltd)',
    incorporatedOn: '2020-09-21',
    registeredOfficeAddress: {
      line1: 'Unit 9, Treforest Industrial Estate',
      line2: '',
      town: 'Pontypridd',
      county: 'Mid Glamorgan',
      postcode: 'CF37 5UR',
      country: 'Wales',
    },
    formerNames: [],
    peopleWithSignificantControl: [
      'Ieuan Bryn Griffiths (50% to 75% shares)',
      'Brynach Plant Hire Ltd (25% to 50% shares)',
    ],
    directors: [
      'Ieuan Bryn Griffiths',
      'Carys Ann Griffiths',
    ],
  },
];

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
 * Searches demo Companies House records by company name or registration number.
 * If the user types a custom name that doesn't match a preset record, also synthesises
 * a realistic demo Companies House hit so any company name can be tested.
 */
export function searchCompaniesHouseDemo(
  query: string,
): CompaniesHouseCompanyRecord[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const lower = q.toLowerCase();

  const matches = DEMO_COMPANIES_HOUSE_RECORDS.filter(
    (rec) =>
      rec.companyName.toLowerCase().includes(lower) ||
      rec.companyNumber.toLowerCase().includes(lower) ||
      rec.formerNames.some((fn) => fn.toLowerCase().includes(lower)),
  );

  // If the user typed at least 3 chars and there's no exact company name match,
  // include a realistic synthesised demo company at the bottom so any name can be tested.
  const hasExact = matches.some(
    (m) => m.companyName.toLowerCase() === lower || m.companyNumber.toLowerCase() === lower,
  );

  if (!hasExact && q.length >= 3) {
    const isLlp = /\bllp\b/i.test(q);
    const isPlc = /\bplc\b/i.test(q);
    const formattedName =
      isLlp || isPlc || /\b(ltd|limited|trust|foundation)\b/i.test(q)
        ? q.replace(/\b\w/g, (c) => c.toUpperCase())
        : `${q.replace(/\b\w/g, (c) => c.toUpperCase())} Ltd`;
    const baseStem = formattedName
      .replace(/\s+(Ltd|Limited|LLP|PLC)$/i, '')
      .trim();

    let hash = 0;
    for (let i = 0; i < lower.length; i++) {
      hash = (hash * 31 + lower.charCodeAt(i)) % 90000000;
    }
    const numStr = isLlp
      ? `OC${String(300000 + (hash % 699999))}`
      : String(10000000 + (hash % 89999999));

    const synthetic: CompaniesHouseCompanyRecord = {
      companyNumber: numStr,
      companyName: formattedName,
      companyStatus: 'Active',
      organisationTypeLabel: isLlp ? 'LLP' : isPlc ? 'plc' : 'Company',
      companyTypeDescription: isLlp
        ? 'Limited liability partnership (LLP)'
        : isPlc
          ? 'Public limited company (PLC)'
          : 'Private limited company (Ltd)',
      incorporatedOn: '2016-04-12',
      registeredOfficeAddress: {
        line1: '1 Capital Quarter, Tyndall Street',
        line2: '',
        town: 'Cardiff',
        county: 'South Glamorgan',
        postcode: 'CF10 4BZ',
        country: 'Wales',
      },
      formerNames: [`${baseStem} (UK) Ltd`],
      peopleWithSignificantControl: [
        ` Dewi Arthur Morgan (75% or more shares)`.trim(),
      ],
      directors: ['Dewi Arthur Morgan', 'Lowri Jane Jenkins'],
    };

    return [...matches, synthetic];
  }

  return matches;
}
