import { describe, expect, it } from 'vitest';
import {
  addressesMatch,
  normaliseEmail,
  normaliseOrgName,
  normalisePhone,
  normalisePostcode,
  normaliseRegNumber,
  normaliseText,
  phoneticKey,
  tokensSoundAlike,
} from '../domain/normalise';
import { ARTICLES, DOC_SECTIONS, getDocArticle } from '../docs/registry';
import { buildSeedLists, vid } from '../seed/lists';
import { buildDemoData } from '../seed/demo';
import { buildSearchIndex } from '../domain/searchIndex';
import { search } from '../domain/search';
import {
  findOrganisationDuplicates,
  findPersonDuplicates,
  formatDuplicateReasons,
} from '../domain/duplicates';
import { canDeactivate, optionsFor, resolveLabel, valueBySystemKey } from '../domain/lists';
import { planMerge } from '../domain/merge';
import { attentionList } from '../domain/attention';
import { validateCustomFields } from '../domain/customFields';
import {
  addWorkingDays,
  addWorkingHours,
  calculateFirstContactDue,
  formatDate,
  formatKeyDateCountdown,
} from '../domain/dates';
import {
  extractCriticalDates,
  fieldGroupsForSubcategory,
  findSubcategoryRule,
  isFieldRequiredAtStage,
  MATTER_FIELD_MODEL,
  specificFieldsForSubcategory,
} from '../domain/matters';
import {
  findEnquiryEntityMatches,
  runEnquiryConflictSearch,
  shouldSuggestNoResponse,
  sortEnquiriesQueue,
  validateEnquiryInput,
} from '../domain/enquiries';
import {
  countMyUrgentBadgeTasks,
  findPracticeAreaRoutingClashes,
  groupMyTasks,
  resolveRoutedTeam,
} from '../domain/tasks';

describe('normalise', () => {
  it('strips accents and punctuation in text and org names', () => {
    expect(normaliseText('Tŷ Glas Developments Ltd')).toBe('ty glas developments ltd');
    expect(normaliseOrgName('Tŷ Glas Developments Ltd')).toBe('ty gla development');
    expect(normaliseOrgName('Ty Glas Development Limited')).toBe('ty gla development');
    expect(normaliseOrgName('Hughes Lloyd Accountants LLP')).toBe('hughe lloyd accountant');
  });

  it('normalises phones, postcodes, emails and registration numbers', () => {
    expect(normalisePhone('+44 (0)29 2018 0746')).toBe('02920180746');
    expect(normalisePhone('029 2018 0746')).toBe('02920180746');
    expect(normalisePostcode('cf10 5fq')).toBe('CF105FQ');
    expect(normaliseEmail('  Gareth.Hughes@HughesLloyd.example ')).toBe('gareth.hughes@hugheslloyd.example');
    expect(normaliseRegNumber('GB 318 4471 26')).toBe('318447126');
  });
});

describe('dates', () => {
  it('formats UK dates as 15 Oct 2026', () => {
    expect(formatDate('2026-10-15')).toBe('15 Oct 2026');
  });
});

describe('lists', () => {
  const { values } = buildSeedLists();

  it('resolves labels by id and reflects renames everywhere', () => {
    const id = vid('relationship_status', 'Active');
    expect(resolveLabel(values, id)).toBe('Active');
    const renamed = values.map((v) => (v.id === id ? { ...v, label: 'Current' } : v));
    expect(resolveLabel(renamed, id)).toBe('Current');
  });

  it('excludes inactive values from new pickers but keeps currently selected inactive values', () => {
    const id = vid('relationship_status', 'Dormant');
    const updated = values.map((v) => (v.id === id ? { ...v, active: false } : v));
    expect(optionsFor(updated, 'relationship_status', []).some((v) => v.id === id)).toBe(false);
    expect(optionsFor(updated, 'relationship_status', id).some((v) => v.id === id)).toBe(true);
  });

  it('prevents deactivating system-keyed values', () => {
    const deceased = valueBySystemKey(values, 'person_record_status', 'deceased')!;
    expect(canDeactivate(deceased).ok).toBe(false);
  });
});

describe('search, duplicates, merge and attention against demo data', () => {
  const today = new Date(2026, 9, 16);
  const seedLists = buildSeedLists();
  const demo = buildDemoData(today);
  const allValues = [...seedLists.values, ...demo.customValues];
  const index = buildSearchIndex(demo.people, demo.organisations, demo.links, allValues);

  it('searching "ty glas" finds both Tŷ Glas organisations and flags the duplicate', () => {
    const res = search(index, 'ty glas');
    const ids = res.organisations.map((h) => h.doc.id);
    expect(ids).toContain('O-000013');
    expect(ids).toContain('O-000016');
    const tyGlas = res.organisations.find((h) => h.doc.id === 'O-000013')!;
    expect(tyGlas.doc.pills.some((p) => p.label === 'Possible duplicate')).toBe(true);
  });

  it('searching an email or postcode finds the right person', () => {
    const byEmail = search(index, 'mared.hughes@pmail.example');
    expect(byEmail.people[0]?.doc.title).toBe('Mared Hughes');

    const byPostcode = search(index, 'CF5 2LH');
    expect(byPostcode.people.map((p) => p.doc.title)).toContain('Owen Price');
  });

  it('detects person duplicates by email, phone or surname+first/initial', () => {
    const byEmail = findPersonDuplicates(
      { firstName: 'Someone', surname: 'Else', emails: ['mared.hughes@pmail.example'], phones: [] },
      demo.people,
    );
    expect(byEmail[0]?.record.firstName).toBe('Mared');

    const byInitial = findPersonDuplicates(
      { firstName: 'G', surname: 'Hughes', emails: [], phones: [] },
      demo.people,
    );
    expect(byInitial.length).toBeGreaterThanOrEqual(2);
  });

  it('detects organisation duplicates across Ltd/Limited and accents', () => {
    const dupes = findOrganisationDuplicates({ legalName: 'Ty Glas Development Ltd' }, demo.organisations);
    expect(dupes.map((d) => d.record.id)).toContain('O-000013');
  });

  it('merges the duplicate Gareth Hughes keeping all emails and tags', () => {
    const g1 = demo.people.find((p) => p.id === 'P-000011')!;
    const g2 = demo.people.find((p) => p.id === 'P-000012')!;
    const { survivor, fieldsTaken } = planMerge(g1, g2);
    expect(survivor.emails.map((e) => e.address)).toEqual([
      'gareth.hughes@hugheslloyd.example',
      'garethhughes@pmail.example',
    ]);
    expect(survivor.tags).toContain('newsletter');
    expect(fieldsTaken).toContain('Email addresses');
  });

  it('surfaces attention signals: conflict, expired verification, duplicate, overdue review, stale', () => {
    const items = attentionList([...demo.people, ...demo.organisations], allValues, today);
    const kinds = new Set(items.map((i) => i.kind));
    expect(kinds.has('potential_conflict')).toBe(true);
    expect(kinds.has('verification_expired')).toBe(true);
    expect(kinds.has('possible_duplicate')).toBe(true);
    expect(kinds.has('review_overdue')).toBe(true);
    expect(kinds.has('stale')).toBe(true);
  });

  it('validates custom fields against active definitions', () => {
    const res = validateCustomFields(
      demo.customFields,
      'person',
      { cf_will_held: 'yes', cf_will_reference: 'W-2026-0999' },
      {},
      allValues,
    );
    expect(res.errors).toEqual({});
    expect(res.values).toEqual({ cf_will_held: true, cf_will_reference: 'W-2026-0999' });
  });
});

describe('3-layer conditional matter field model', () => {
  const today = new Date(2026, 9, 16);
  const seedLists = buildSeedLists();
  const demo = buildDemoData(today);
  const allValues = [...seedLists.values, ...demo.customValues];

  it('loads all 75 core fields, 9 field groups (86 fields), 66 subcategory rules and 590 subcategory fields', () => {
    expect(MATTER_FIELD_MODEL.coreFields.length).toBe(75);
    expect(MATTER_FIELD_MODEL.fieldGroups.length).toBe(9);
    expect(MATTER_FIELD_MODEL.fieldGroups.reduce((s, g) => s + g.fields.length, 0)).toBe(86);
    expect(MATTER_FIELD_MODEL.subcategoryMatrix.length).toBe(66);
    expect(MATTER_FIELD_MODEL.subcategoryFields.length).toBe(590);
  });

  it('resolves Subcategory Matrix rules, active Field Groups and Subcategory-Specific Fields accurately', () => {
    const resConv = findSubcategoryRule('Residential conveyancing')!;
    expect(resConv.code).toBe('RE01');
    expect(resConv.typeBadge).toBe('Residential');
    expect(resConv.defaultMatterType).toBe('Transactional');
    expect(resConv.typicalBillingBasis).toBe('Fixed Fee');
    expect(resConv.fieldGroupCodes).toEqual(['FG03', 'FG08']);

    const groups = fieldGroupsForSubcategory('Residential conveyancing');
    expect(groups.map((g) => g.code)).toEqual(['FG03', 'FG08']);

    const specific = specificFieldsForSubcategory('Residential conveyancing');
    expect(specific.length).toBe(19);
    expect(specific[0]?.id).toBe('RE01-01');
  });

  it('evaluates stage-gated required rules and extracts critical dates', () => {
    expect(isFieldRequiredAtStage('Opening', 1)).toBe(true);
    expect(isFieldRequiredAtStage('Stage 3', 2)).toBe(false);
    expect(isFieldRequiredAtStage('Stage 3', 3)).toBe(true);
    expect(isFieldRequiredAtStage('Closure', 4, 'Active')).toBe(false);
    expect(isFieldRequiredAtStage('Closure', 7, 'Closed')).toBe(true);

    const maredMatter = demo.matters[1]!;
    const crit = extractCriticalDates(maredMatter, 'Residential conveyancing');
    expect(crit.length).toBeGreaterThanOrEqual(4);
  });

  it('indexes matters in search by matter number, title and client name', () => {
    const index = buildSearchIndex(demo.people, demo.organisations, demo.links, allValues, demo.matters);
    const byNumber = search(index, 'PEN001-0004');
    expect(byNumber.matters[0]?.doc.id).toBe('M-000001');

    const byTitle = search(index, 'Project Severn');
    expect(byTitle.matters[0]?.doc.id).toBe('M-000003');
  });
});

describe('enquiries and tasks', () => {
  const today = new Date(2026, 9, 16, 10, 0, 0);
  const seedLists = buildSeedLists();
  const demo = buildDemoData(today);
  const allValues = [...seedLists.values, ...demo.customValues];

  it('validates enquiry input and requires phone or email plus privacy notice', () => {
    const missingContact = validateEnquiryInput({
      firstName: 'Megan',
      lastName: 'Thomas',
      channelId: vid('enquiry_channel', 'Phone'),
      practiceAreaId: vid('work_type', 'Employment & HR'),
      summary: 'Settlement agreement review',
      notes: 'Wants independent advice',
      urgencyId: vid('enquiry_urgency', 'Urgent'),
      privacyNoticeGiven: false,
      phone: '',
      email: '',
    });
    expect(missingContact.contact).toBeDefined();
    expect(missingContact.privacyNoticeGiven).toBeDefined();

    const valid = validateEnquiryInput({
      firstName: 'Megan',
      lastName: 'Thomas',
      channelId: vid('enquiry_channel', 'Phone'),
      practiceAreaId: vid('work_type', 'Employment & HR'),
      summary: 'Settlement agreement review',
      notes: 'Wants independent advice',
      urgencyId: vid('enquiry_urgency', 'Urgent'),
      privacyNoticeGiven: true,
      phone: '07700 900412',
    });
    expect(valid).toEqual({});
  });

  it('routes enquiries by practice area and falls back to Intake when unmapped', () => {
    const empPa = vid('work_type', 'Employment & HR');
    const routedEmp = resolveRoutedTeam(empPa, demo.teams);
    expect(routedEmp.team?.name).toBe('Employment & HR');
    expect(routedEmp.isFallbackIntake).toBe(false);

    const unmapped = resolveRoutedTeam('work_type.unknown_practice_area', demo.teams);
    expect(unmapped.team?.name).toBe('Intake');
    expect(unmapped.isFallbackIntake).toBe(true);

    expect(findPracticeAreaRoutingClashes(demo.teams)).toEqual([]);
  });

  it('calculates working hours and working days respecting weekends and bank holidays', () => {
    const dueEmergency = calculateFirstContactDue('2026-10-16T10:00:00.000Z', 'Emergency');
    expect(dueEmergency.startsWith('2026-10-16')).toBe(true);

    const dueUrgent = calculateFirstContactDue('2026-10-16T10:00:00.000Z', 'Urgent');
    expect(dueUrgent.startsWith('2026-10-16')).toBe(true);

    // Friday 16 Oct 2026 + 1 working day -> Monday 19 Oct 2026
    const dueStandard = calculateFirstContactDue('2026-10-16T10:00:00.000Z', 'Standard');
    expect(dueStandard.startsWith('2026-10-19')).toBe(true);

    const plusFive = addWorkingDays(new Date(2026, 9, 16, 10, 0, 0), 5);
    expect(plusFive.getFullYear()).toBe(2026);
    expect(plusFive.getMonth()).toBe(9);
    expect(plusFive.getDate()).toBe(23);

    const countdown = formatKeyDateCountdown('2026-10-18', today);
    expect(countdown?.label).toBe('In 2 days');
  });

  it('detects existing People/Organisations and flags conflicts when other parties match a client', () => {
    const matches = findEnquiryEntityMatches(
      {
        firstName: 'Mared',
        lastName: 'Hughes',
        email: 'mared.hughes@pmail.example',
        callingOnBehalfOf: 'Penarth Estates',
      },
      demo.people,
      demo.organisations,
    );
    expect(matches.people.some((m) => m.person.id === 'P-000013')).toBe(true);
    expect(matches.organisations.some((m) => m.organisation.id === 'O-000001')).toBe(true);

    const conflicts = runEnquiryConflictSearch(
      {
        firstName: 'David',
        lastName: 'Bevan',
        otherPartiesNamed: 'Penarth Estates Ltd',
      },
      demo.people,
      demo.organisations,
      demo.matters,
      allValues,
    );
    expect(conflicts.hasBlockingConflict).toBe(true);
    expect(conflicts.otherPartyClientMatches[0]?.recordId).toBe('O-000001');
  });

  it('sorts enquiries with Emergency and Urgent first, then oldest first, and suggests No response after 3 failed attempts', () => {
    const sorted = sortEnquiriesQueue(demo.enquiries.filter((e) => e.status === 'New' || e.status === 'Assigned'), allValues);
    const firstUrgLabel = resolveLabel(allValues, sorted[0]?.urgencyId);
    expect(['Emergency', 'Urgent']).toContain(firstUrgLabel);

    const enq2 = demo.enquiries.find((e) => e.id === 'ENQ-000002')!;
    expect(shouldSuggestNoResponse(enq2, 3)).toBe(false);
    expect(shouldSuggestNoResponse(enq2, 2)).toBe(true);
  });

  it('groups My tasks and indexes enquiries and tasks in global search and attention list', () => {
    const groups = groupMyTasks(demo.tasks, 'P-000001', today);
    expect(groups.overdue.length + groups.dueToday.length + groups.dueThisWeek.length).toBeGreaterThan(0);
    expect(countMyUrgentBadgeTasks(demo.tasks, 'P-000001', today)).toBe(
      groups.overdue.length + groups.dueToday.length,
    );

    const index = buildSearchIndex(
      demo.people,
      demo.organisations,
      demo.links,
      allValues,
      demo.matters,
      demo.enquiries,
      demo.tasks,
      demo.teams,
    );
    const enqRes = search(index, 'ENQ-000001');
    expect(enqRes.enquiries[0]?.doc.id).toBe('ENQ-000001');

    const tskRes = search(index, 'TSK-000001');
    expect(tskRes.tasks[0]?.doc.id).toBe('TSK-000001');

    const att = attentionList(
      [...demo.people, ...demo.organisations],
      allValues,
      today,
      {
        enquiries: demo.enquiries,
        tasks: demo.tasks,
        teams: demo.teams,
      },
    );
    const attKinds = new Set(att.map((a) => a.kind));
    expect(attKinds.has('overdue_task')).toBe(true);
    expect(attKinds.has('unclaimed_urgent_enquiry')).toBe(true);
  });
});

describe('Quick Conflict Check (New Enquiry screen)', () => {
  const seedLists = buildSeedLists();
  const demo = buildDemoData(new Date(2026, 9, 18, 10, 0, 0));
  const allValues = [...seedLists.values, ...demo.customValues];

  // Seeded fixture records covering all required cases
  const sianLewis = {
    ...demo.people.find((p) => !p.isEmployee)!,
    id: 'P-900001',
    firstName: 'Sian',
    surname: 'Lewis',
    preferredName: '',
    otherNames: [],
    isEmployee: false,
    mergedIntoId: null,
    notDuplicateOf: [],
    emails: [
      {
        id: 'e-sian',
        address: 'sian.lewis@penarthestates.co.uk',
        typeId: vid('email_type', 'Work'),
        isPrimary: true,
      },
    ],
    phones: [
      {
        id: 'ph-sian',
        number: '029 2010 4400',
        typeId: vid('phone_type', 'Direct'),
      },
    ],
    addresses: [
      {
        id: 'addr-sian',
        typeId: vid('address_type', 'Home'),
        line1: '15 Cathedral Road',
        line2: '',
        town: 'Cardiff',
        county: 'South Glamorgan',
        postcode: 'CF11 9LJ',
        countryId: vid('country', 'United Kingdom'),
      },
    ],
    relationshipRoleIds: [vid('person_role', 'Client contact')],
  };

  const castellHomes = {
    ...demo.organisations[0]!,
    id: 'O-900001',
    legalName: 'Castell Homes Ltd',
    otherNames: [],
    mergedIntoId: null,
    notDuplicateOf: [],
    organisationTypeId: 'Opposite Party',
    relationshipTypeIds: [vid('organisation_relationship_type', 'Counterparty')],
    generalEmail: 'enquiries@castellhomes.co.uk',
    website: 'https://castellhomes.co.uk',
    mainPhone: '029 2099 1100',
    registeredAddress: {
      id: 'addr-castell',
      typeId: vid('address_type', 'Registered office'),
      line1: '1 Castell Way',
      line2: '',
      town: 'Cardiff',
      county: 'South Glamorgan',
      postcode: 'CF14 4AA',
      countryId: vid('country', 'United Kingdom'),
    },
    correspondenceAddress: null,
    billingAddress: null,
  };

  const penarthCoUk = {
    ...demo.organisations.find((o) => o.id === 'O-000001')!,
    generalEmail: 'info@penarthestates.co.uk',
    website: 'https://penarthestates.co.uk',
  };

  const fixturePeople = [
    ...demo.people.filter((p) => p.id !== sianLewis.id),
    sianLewis,
  ];
  const fixtureOrgs = [
    ...demo.organisations.map((o) => (o.id === 'O-000001' ? penarthCoUk : o)),
    castellHomes,
  ];

  it('Field-by-field: Caller name "Siân Lewis" matches existing Person "Sian Lewis"', () => {
    const res = findEnquiryEntityMatches(
      { firstName: 'Siân', lastName: 'Lewis' },
      fixturePeople,
      fixtureOrgs,
    );
    expect(res.people.some((m) => m.person.id === 'P-900001')).toBe(true);
  });

  it('Field-by-field: On behalf of "Castell Homes Limited" matches Organisation "Castell Homes Ltd" (Opposite Party -> high severity)', () => {
    const conflicts = runEnquiryConflictSearch(
      { callingOnBehalfOf: 'Castell Homes Limited' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const hit = conflicts.allConflicts.find((c) => c.recordId === 'O-900001');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('high');
    expect(conflicts.hasBlockingConflict).toBe(true);

    const entities = findEnquiryEntityMatches(
      { callingOnBehalfOf: 'Castell Homes Limited' },
      fixturePeople,
      fixtureOrgs,
    );
    expect(entities.organisations.some((m) => m.organisation.id === 'O-900001')).toBe(true);
  });

  it('Field-by-field: On behalf of "castell homes" (lower case) also matches', () => {
    const conflicts = runEnquiryConflictSearch(
      { callingOnBehalfOf: 'castell homes' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    expect(conflicts.allConflicts.some((c) => c.recordId === 'O-900001' && c.severity === 'high')).toBe(
      true,
    );

    const entities = findEnquiryEntityMatches(
      { callingOnBehalfOf: 'castell homes' },
      fixturePeople,
      fixtureOrgs,
    );
    expect(entities.organisations.some((m) => m.organisation.id === 'O-900001')).toBe(true);
  });

  it('Field-by-field: Email "SIAN.LEWIS@penarthestates.co.uk " (upper case, trailing space) matches the Person with that email', () => {
    const res = findEnquiryEntityMatches(
      { email: 'SIAN.LEWIS@penarthestates.co.uk ' },
      fixturePeople,
      fixtureOrgs,
    );
    const sianMatch = res.people.find((m) => m.person.id === 'P-900001');
    expect(sianMatch).toBeDefined();
    expect(sianMatch?.reasons).toContain('email');
  });

  it('Field-by-field: Email "someone@penarthestates.co.uk" matches the Organisation by domain', () => {
    const res = findEnquiryEntityMatches(
      { email: 'someone@penarthestates.co.uk' },
      fixturePeople,
      fixtureOrgs,
    );
    const orgMatch = res.organisations.find((m) => m.organisation.id === 'O-000001');
    expect(orgMatch).toBeDefined();
    expect(orgMatch?.reasons).toContain('emailDomain');
  });

  it('Field-by-field: Email "someone@gmail.com" does NOT match any organisation by domain', () => {
    const orgWithGmail = {
      ...castellHomes,
      id: 'O-900099',
      generalEmail: 'contact@gmail.com',
      website: '',
    };
    const res = findEnquiryEntityMatches(
      { email: 'someone@gmail.com' },
      fixturePeople,
      [...fixtureOrgs, orgWithGmail],
    );
    expect(res.organisations.length).toBe(0);
  });

  it('Field-by-field: Phone "+44 29 2010 4400" matches a record stored as "029 2010 4400"', () => {
    const res = findEnquiryEntityMatches(
      { phone: '+44 29 2010 4400' },
      fixturePeople,
      fixtureOrgs,
    );
    const match = res.people.find((m) => m.person.id === 'P-900001');
    expect(match).toBeDefined();
    expect(match?.reasons).toContain('phone');
  });

  it('Field-by-field: Postcode "cf119lj" matches a record stored as "CF11 9LJ", as low strength only', () => {
    const res = findEnquiryEntityMatches(
      { postcode: 'cf119lj' },
      fixturePeople,
      fixtureOrgs,
    );
    const match = res.people.find((m) => m.person.id === 'P-900001');
    expect(match).toBeDefined();
    expect(match?.reasons).toEqual(['postcode']);
    expect(match?.strength).toBe('low');
    expect(match?.formattedReasons).toBe('same postcode');

    const conflicts = runEnquiryConflictSearch(
      {},
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    expect(conflicts.hasBlockingConflict).toBe(false);
  });

  it('Multiple results: Other parties "Castell Homes Ltd, Penarth Estates Ltd" returns TWO separate high-severity results', () => {
    const conflicts = runEnquiryConflictSearch(
      { otherPartiesNamed: 'Castell Homes Ltd, Penarth Estates Ltd' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const castellHit = conflicts.allConflicts.find((c) => c.recordId === 'O-900001');
    const penarthHit = conflicts.allConflicts.find((c) => c.recordId === 'O-000001');
    expect(castellHit).toBeDefined();
    expect(castellHit?.severity).toBe('high');
    expect(penarthHit).toBeDefined();
    expect(penarthHit?.severity).toBe('high');
    expect(conflicts.allConflicts.length).toBeGreaterThanOrEqual(2);
  });

  it('Multiple results: Caller name + email both matching the same Person returns ONE result with both reasons listed', () => {
    const res = findEnquiryEntityMatches(
      {
        firstName: 'Siân',
        lastName: 'Lewis',
        email: 'sian.lewis@penarthestates.co.uk',
      },
      fixturePeople,
      fixtureOrgs,
    );
    const matchesForSian = res.people.filter((m) => m.person.id === 'P-900001');
    expect(matchesForSian.length).toBe(1);
    expect(matchesForSian[0]?.reasons).toContain('name');
    expect(matchesForSian[0]?.reasons).toContain('email');
    expect(matchesForSian[0]?.formattedReasons).toContain('name');
    expect(matchesForSian[0]?.formattedReasons).toContain('email');
  });

  it('Multiple results: Caller matching one Person AND On behalf of matching a different Organisation returns TWO results', () => {
    const res = findEnquiryEntityMatches(
      {
        firstName: 'Mared',
        lastName: 'Hughes',
        callingOnBehalfOf: 'Castell Homes Ltd',
      },
      fixturePeople,
      fixtureOrgs,
    );
    expect(res.people.some((m) => m.person.id === 'P-000013')).toBe(true);
    expect(res.organisations.some((m) => m.organisation.id === 'O-900001')).toBe(true);
    expect(res.people.length + res.organisations.length).toBe(2);
  });

  it('Multiple results: Three different matches -> distinct count is 3; if one is high severity -> Possible conflict state', () => {
    // 1. Caller matches Mared Hughes (P-000013)
    // 2. Calling on behalf of matches Brightwater Care Group Ltd (O-000003)
    // 3. Other parties matches Castell Homes Ltd (O-900001, Opposite Party -> high severity)
    const entities = findEnquiryEntityMatches(
      {
        firstName: 'Mared',
        lastName: 'Hughes',
        callingOnBehalfOf: 'Brightwater Care Group Ltd',
      },
      fixturePeople,
      fixtureOrgs,
    );
    const conflictsNoHigh = runEnquiryConflictSearch(
      {
        firstName: 'Mared',
        lastName: 'Hughes',
        callingOnBehalfOf: 'Brightwater Care Group Ltd',
        otherPartiesNamed: 'Cadwyn Surveying & Valuation Ltd',
      },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const distinctIdsNoHigh = new Set([
      ...conflictsNoHigh.allConflicts.map((c) => `${c.recordType}:${c.recordId}`),
      ...entities.people.map((m) => `person:${m.person.id}`),
      ...entities.organisations.map((m) => `organisation:${m.organisation.id}`),
    ]);
    expect(distinctIdsNoHigh.size).toBe(3);
    expect(conflictsNoHigh.hasBlockingConflict).toBe(false);

    const conflictsWithHigh = runEnquiryConflictSearch(
      {
        firstName: 'Mared',
        lastName: 'Hughes',
        callingOnBehalfOf: 'Brightwater Care Group Ltd',
        otherPartiesNamed: 'Castell Homes Ltd',
      },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const distinctIdsWithHigh = new Set([
      ...conflictsWithHigh.allConflicts.map((c) => `${c.recordType}:${c.recordId}`),
      ...entities.people.map((m) => `person:${m.person.id}`),
      ...entities.organisations.map((m) => `organisation:${m.organisation.id}`),
    ]);
    expect(distinctIdsWithHigh.size).toBe(3);
    expect(conflictsWithHigh.hasBlockingConflict).toBe(true);
  });

  it('Thresholds: "Jo" in the name field -> still Waiting; partial email "sian@" -> no email check; partial phone "029 20" -> no phone check', async () => {
    const { hasQuickConflictCheckInputs } = await import('../domain/enquiries');

    expect(hasQuickConflictCheckInputs({ firstName: 'Jo' })).toBe(false);
    expect(hasQuickConflictCheckInputs({ email: 'sian@' })).toBe(false);
    expect(hasQuickConflictCheckInputs({ phone: '029 20' })).toBe(false);
    expect(hasQuickConflictCheckInputs({ postcode: 'CF11' })).toBe(false);

    expect(
      findEnquiryEntityMatches({ firstName: 'Jo' }, fixturePeople, fixtureOrgs).people.length,
    ).toBe(0);
    expect(
      findEnquiryEntityMatches({ email: 'sian@' }, fixturePeople, fixtureOrgs).people.length,
    ).toBe(0);
    expect(
      findEnquiryEntityMatches({ phone: '029 20' }, fixturePeople, fixtureOrgs).people.length,
    ).toBe(0);
  });

  it('Negative cases: A common surname on its own ("Jones" with no first name) does not produce a high-severity result', () => {
    const conflicts = runEnquiryConflictSearch(
      { lastName: 'Jones' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    expect(conflicts.hasBlockingConflict).toBe(false);
    expect(conflicts.allConflicts.some((c) => c.severity === 'high')).toBe(false);

    const entities = findEnquiryEntityMatches(
      { lastName: 'Jones' },
      fixturePeople,
      fixtureOrgs,
    );
    expect(entities.people.length).toBe(0);
  });

  const lisa = demo.people.find((p) => p.firstName === 'Lisa' && p.surname === 'Kendall')!;

  it('Fuzzy: "Lisa Kendal" (misspelt surname) flags opposite party Lisa Kendall as a medium "check" result, not high', () => {
    const conflicts = runEnquiryConflictSearch(
      { firstName: 'Lisa', lastName: 'Kendal' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const hit = conflicts.allConflicts.find((c) => c.recordId === lisa.id);
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('medium');
    expect(hit?.matchedFields).toContain('caller name (similar spelling)');
    expect(conflicts.hasBlockingConflict).toBe(false);

    const entities = findEnquiryEntityMatches(
      { firstName: 'Lisa', lastName: 'Kendal' },
      fixturePeople,
      fixtureOrgs,
    );
    const known = entities.people.find((m) => m.person.id === lisa.id);
    expect(known?.reasons).toEqual(['similarName']);
    expect(known?.formattedReasons).toBe('similar name');
  });

  it('Fuzzy: exact "Lisa Kendall" is still high severity', () => {
    const conflicts = runEnquiryConflictSearch(
      { firstName: 'Lisa', lastName: 'Kendall' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    expect(conflicts.allConflicts.find((c) => c.recordId === lisa.id)?.severity).toBe('high');
  });

  it('Fuzzy: transposed letters and misspelt non-conflict people are offered as "similar name"', () => {
    const entities = findEnquiryEntityMatches(
      { firstName: 'Mraed', lastName: 'Hughes' },
      fixturePeople,
      fixtureOrgs,
    );
    expect(entities.people.find((m) => m.person.id === 'P-000013')?.reasons).toContain('similarName');
  });

  it('Fuzzy: misspelt organisation "Castel Homes" flags Castell Homes Ltd as medium', () => {
    const conflicts = runEnquiryConflictSearch(
      { callingOnBehalfOf: 'Castel Homes' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const hit = conflicts.allConflicts.find((c) => c.recordId === 'O-900001');
    expect(hit?.severity).toBe('medium');
  });

  it('Fuzzy: short names and lone surnames do not fuzzy match (no noise)', () => {
    // 3-letter tokens get no tolerance: "Sam Jones" must not match "Tom Jones"-style names
    const entities = findEnquiryEntityMatches(
      { firstName: 'Tim', lastName: 'Jones' },
      fixturePeople,
      fixtureOrgs,
    );
    expect(entities.people.some((m) => m.reasons.includes('similarName'))).toBe(false);
    expect(
      findEnquiryEntityMatches({ lastName: 'Kendal' }, fixturePeople, fixtureOrgs).people.length,
    ).toBe(0);
  });

  it("Contact details: an opposite party's email on its own is a high-severity possible conflict", () => {
    const conflicts = runEnquiryConflictSearch(
      { email: 'Lisa.Kendall@morganprice.example' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const hit = conflicts.allConflicts.find((c) => c.recordId === lisa.id);
    expect(hit?.severity).toBe('high');
    expect(hit?.matchedFields).toContain('email');
    expect(conflicts.hasBlockingConflict).toBe(true);
  });

  it("Contact details: an opposite party's phone on its own is a high-severity possible conflict", () => {
    const conflicts = runEnquiryConflictSearch(
      { phone: '+44 29 2018 0863' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    expect(conflicts.allConflicts.find((c) => c.recordId === lisa.id)?.severity).toBe('high');
  });

  it('Contact details: name + email for the same opposite party merges into ONE result', () => {
    const conflicts = runEnquiryConflictSearch(
      { firstName: 'Lisa', lastName: 'Kendall', email: 'lisa.kendall@morganprice.example' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const hits = conflicts.allConflicts.filter((c) => c.recordId === lisa.id);
    expect(hits.length).toBe(1);
    expect(hits[0]?.matchedFields).toEqual(expect.arrayContaining(['caller name', 'email']));
  });

  it('Contact details: an email at an opposite party organisation domain is medium, never from a free provider', () => {
    const conflicts = runEnquiryConflictSearch(
      { email: 'someone@castellhomes.co.uk' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    expect(conflicts.allConflicts.find((c) => c.recordId === 'O-900001')?.severity).toBe('medium');

    const gmailOrg = { ...castellHomes, id: 'O-900098', generalEmail: 'x@gmail.com', website: '' };
    const free = runEnquiryConflictSearch(
      { email: 'someone@gmail.com' },
      fixturePeople,
      [...fixtureOrgs, gmailOrg],
      demo.matters,
      allValues,
    );
    expect(free.allConflicts.some((c) => c.recordId === 'O-900098')).toBe(false);
  });

  it('Sound-alike: phonetic keys group names that are pronounced the same', () => {
    const same: [string, string][] = [
      ['Davies', 'Davis'],
      ['Smith', 'Smyth'],
      ['Rhys', 'Reece'],
      ['Catherine', 'Kathryn'],
      ['Thompson', 'Thomson'],
      ['Phillips', 'Philips'],
      ['Kendle', 'Kendall'],
      ['Dylan', 'Dillon'],
    ];
    for (const [a, b] of same) {
      expect(tokensSoundAlike(a.toLowerCase(), b.toLowerCase()), `${a}/${b}`).toBe(true);
    }
    expect(tokensSoundAlike('jon', 'john')).toBe(true);
  });

  it('Sound-alike: different names do not match', () => {
    const different: [string, string][] = [
      ['tim', 'tom'],
      ['ian', 'ann'],
      ['elin', 'alun'],
      ['owen', 'evans'],
      ['hughes', 'hewitt'],
    ];
    for (const [a, b] of different) {
      expect(tokensSoundAlike(a, b), `${a}/${b}`).toBe(false);
    }
    expect(phoneticKey('Elin')).not.toBe(phoneticKey('Alun'));
  });

  it('Sound-alike: "Lisa Kendle" (too far for a misspelling) flags Lisa Kendall as "sounds like", medium', () => {
    const conflicts = runEnquiryConflictSearch(
      { firstName: 'Lisa', lastName: 'Kendle' },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const hit = conflicts.allConflicts.find((c) => c.recordId === lisa.id);
    expect(hit?.severity).toBe('medium');
    expect(hit?.matchedFields).toContain('caller name (sounds like)');
    expect(hit?.reason).toContain('sounds like');

    const known = findEnquiryEntityMatches(
      { firstName: 'Lisa', lastName: 'Kendle' },
      fixturePeople,
      fixtureOrgs,
    ).people.find((m) => m.person.id === lisa.id);
    expect(known?.reasons).toEqual(['soundsLike']);
    expect(known?.formattedReasons).toBe('name sounds alike');
  });

  it('Address: matches on postcode + first line, ignoring case, punctuation and abbreviations', () => {
    const stored = { line1: '3 Bute Dock Chambers, Mount Stuart Square', postcode: 'CF10 5FQ' };
    expect(addressesMatch({ line1: '3 bute dock chambers', postcode: 'cf105fq' }, stored)).toBe(true);
    expect(
      addressesMatch({ line1: '15 Cathedral Rd', postcode: 'CF11 9LJ' }, { line1: '15 Cathedral Road', postcode: 'CF11 9LJ' }),
    ).toBe(true);
    // House number must match exactly: "1" is not "12"
    expect(
      addressesMatch({ line1: '1 High Street', postcode: 'CF10 1AA' }, { line1: '12 High Street', postcode: 'CF10 1AA' }),
    ).toBe(false);
    // Different postcode never matches
    expect(addressesMatch({ line1: '3 Bute Dock Chambers', postcode: 'CF10 5FR' }, stored)).toBe(false);
  });

  it("Address: the caller's address matching an opposite party is a medium conflict; postcode alone is not", () => {
    const conflicts = runEnquiryConflictSearch(
      { address: { line1: '1 Castell Way', postcode: 'cf14 4aa' } },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    const hit = conflicts.allConflicts.find((c) => c.recordId === 'O-900001');
    expect(hit?.severity).toBe('medium');
    expect(hit?.matchedFields).toEqual(['address']);

    const postcodeOnly = runEnquiryConflictSearch(
      { address: { line1: '', postcode: 'CF14 4AA' } },
      fixturePeople,
      fixtureOrgs,
      demo.matters,
      allValues,
    );
    expect(postcodeOnly.allConflicts.length).toBe(0);

    const known = findEnquiryEntityMatches(
      { addressLine1: '15 Cathedral Rd', postcode: 'CF11 9LJ' },
      fixturePeople,
      fixtureOrgs,
    ).people.find((m) => m.person.id === 'P-900001');
    expect(known?.reasons).toEqual(['address']);
    expect(known?.formattedReasons).toBe('same address');
  });

  it('Forms: People duplicate check finds misspelt and sound-alike names only when fuzzy is on', () => {
    const plain = findPersonDuplicates(
      { firstName: 'Lisa', surname: 'Kendal', emails: [], phones: [] },
      fixturePeople,
    );
    expect(plain.some((m) => m.record.id === lisa.id)).toBe(false);

    const fuzzy = findPersonDuplicates(
      { firstName: 'Lisa', surname: 'Kendal', emails: [], phones: [] },
      fixturePeople,
      [],
      { fuzzy: true },
    );
    expect(fuzzy.find((m) => m.record.id === lisa.id)?.reasons).toEqual(['similarName']);
    expect(formatDuplicateReasons(['similarName', 'email'])).toBe('similar name, email');
  });

  it('Forms: Organisation duplicate check matches a misspelt name, email domain and phone', () => {
    const res = findOrganisationDuplicates(
      {
        legalName: 'Castel Homes',
        emails: ['accounts@castellhomes.co.uk'],
        phones: ['029 2099 1100'],
      },
      fixtureOrgs,
      [],
      { fuzzy: true },
    );
    const castell = res.find((m) => m.record.id === 'O-900001');
    expect(castell?.reasons).toEqual(expect.arrayContaining(['similarName', 'emailDomain', 'phone']));
  });
});

describe('System documentation', () => {
  it('has unique slugs, valid sections and working internal links', () => {
    const slugs = ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(getDocArticle('quick-conflict-check')).toBeDefined();
    expect(getDocArticle('duplicate-checks')).toBeDefined();

    const sectionKeys = DOC_SECTIONS.map((s) => s.key as string);
    for (const a of ARTICLES) {
      expect(sectionKeys, a.slug).toContain(a.section);
      expect(a.updated, a.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const m of a.body.matchAll(/\]\(\/docs\/([a-z0-9-]+)/g)) {
        expect(slugs, `${a.slug} links to /docs/${m[1]}`).toContain(m[1]);
      }
    }
  });
});



