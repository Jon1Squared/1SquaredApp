import { describe, expect, it } from 'vitest';
import {
  computeEnquiryDashboardMetrics,
  extractEnquiryFormInitialState,
  filterEnquiriesForPracticeAreasAndTeams,
  formatLondonDateIso,
  validateEnquiryInput,
} from '../enquiries';
import { valueBySystemKey } from '../lists';
import { saveEnquiryRecord } from '../../server/services';
import { getStore } from '../../server/store';
import type { Enquiry } from '../types';

function makeEnquiry(overrides: Partial<Enquiry>): Enquiry {
  return {
    id: 'ENQ-1',
    reference: 'ENQ-1',
    receivedAt: '2026-11-05T10:00:00Z',
    takenById: 'P-1',
    channelId: 'enquiry_channel.phone',
    firstName: 'Alex',
    lastName: 'Morgan',
    callingOnBehalfOf: '',
    linkedOrganisationId: null,
    email: 'alex.morgan@example.com',
    phone: '01632 960101',
    preferredContactMethodId: null,
    bestTimeToCall: '',
    address: null,
    practiceAreaId: 'work_type.real_estate_and_property',
    workTypeSubcategoryId: null,
    summary: 'Test enquiry',
    notes: '',
    otherPartiesNamed: '',
    urgencyId: 'enquiry_urgency.standard',
    keyDate: null,
    keyDateLabel: '',
    sourceId: 'origin.website',
    referrerPersonId: null,
    privacyNoticeGiven: true,
    linkedPersonId: null,
    assignedTeamId: null,
    assignedToId: 'P-1',
    status: 'Assigned',
    firstContactDueAt: '2026-11-10T17:30:00Z',
    nextActionDate: null,
    closeReasonId: null,
    referredToOrganisationId: null,
    convertedMatterId: null,
    contactLog: [],
    createdById: 'P-1',
    createdAt: '2026-11-05T10:00:00Z',
    updatedById: 'P-1',
    updatedAt: '2026-11-05T10:00:00Z',
    ...overrides,
  } as Enquiry;
}

describe('computeEnquiryDashboardMetrics and enquiry form defaults (R324, R342, R343, R347)', () => {
  it('excludes prior-month enquiries from monthly counts, excludes already-contacted enquiries from callbacksDueTodayCount, and excludes uncontacted not-yet-due enquiries from SLA met % (R324, R343)', () => {
    const enquiries: Enquiry[] = [
      // 1. Prior month (October) Converted enquiry — excluded from November monthly counts; contacted within SLA
      makeEnquiry({
        id: 'ENQ-OCT-CONV',
        receivedAt: '2026-10-12T09:00:00Z',
        status: 'Converted',
        firstContactDueAt: '2026-10-12T17:30:00Z',
        contactLog: [
          {
            id: 'CL-1',
            at: '2026-10-12T11:00:00Z',
            byId: 'P-1',
            method: 'Call',
            outcome: 'Spoke',
            note: 'Spoke to client',
          },
        ],
      }),
      // 2. Prior month (October) In contact enquiry — excluded from November monthly counts
      makeEnquiry({
        id: 'ENQ-OCT-OPEN',
        receivedAt: '2026-10-28T14:00:00Z',
        status: 'In contact',
        firstContactDueAt: '2026-10-29T17:30:00Z',
        contactLog: [
          {
            id: 'CL-OCT-2',
            at: '2026-10-28T16:00:00Z',
            byId: 'P-1',
            method: 'Call',
            outcome: 'Spoke',
            note: 'Initial call',
          },
        ],
      }),
      // 3. Current month (November) enquiry due today and UNCONTACTED — counts in callbacksDueTodayCount, excluded from SLA denominator at 12:00
      makeEnquiry({
        id: 'ENQ-DUE-TODAY-UNCONTACTED',
        receivedAt: '2026-11-09T09:00:00Z',
        status: 'Assigned',
        assignedToId: null,
        firstContactDueAt: '2026-11-09T17:30:00Z',
        contactLog: [],
      }),
      // 4. Current month (November) enquiry due today that HAS ALREADY BEEN CONTACTED — excluded from callbacksDueTodayCount (R343)
      makeEnquiry({
        id: 'ENQ-DUE-TODAY-CONTACTED',
        receivedAt: '2026-11-09T08:30:00Z',
        status: 'In contact',
        firstContactDueAt: '2026-11-09T17:30:00Z',
        contactLog: [
          {
            id: 'CL-TODAY-1',
            at: '2026-11-09T09:15:00Z',
            byId: 'P-1',
            method: 'Call',
            outcome: 'Spoke',
            note: 'Called client back on time',
          },
        ],
      }),
      // 5. Current month (November) enquiry overdue and uncontacted — counts in SLA denominator as missed
      makeEnquiry({
        id: 'ENQ-OVERDUE',
        receivedAt: '2026-11-04T09:00:00Z',
        status: 'Assigned',
        firstContactDueAt: '2026-11-05T17:30:00Z',
        contactLog: [],
      }),
      // 6. Current month (November) enquiry converted and contacted on time — counts in Nov converted and SLA met
      makeEnquiry({
        id: 'ENQ-NOV-CONV',
        receivedAt: '2026-11-06T09:00:00Z',
        status: 'Converted',
        firstContactDueAt: '2026-11-06T17:30:00Z',
        contactLog: [
          {
            id: 'CL-2',
            at: '2026-11-06T10:30:00Z',
            byId: 'P-1',
            method: 'Call',
            outcome: 'Spoke',
            note: 'Converted',
          },
        ],
      }),
    ];

    const metrics = computeEnquiryDashboardMetrics(enquiries, '2026-11-09T12:00:00Z');
    expect(metrics.monthEnquiries.map((e) => e.id)).toEqual([
      'ENQ-DUE-TODAY-UNCONTACTED',
      'ENQ-DUE-TODAY-CONTACTED',
      'ENQ-OVERDUE',
      'ENQ-NOV-CONV',
    ]);
    expect(metrics.monthReceivedCount).toBe(4);
    expect(metrics.monthConvertedCount).toBe(1);
    expect(metrics.monthConversionPct).toBe(25);
    expect(metrics.monthOpenCount).toBe(3);
    expect(metrics.monthInContactCount).toBe(1);
    expect(metrics.monthUnassignedCount).toBe(1);
    // Only ENQ-DUE-TODAY-UNCONTACTED is counted; ENQ-DUE-TODAY-CONTACTED is excluded because contactLog is non-empty
    expect(metrics.callbacksDueTodayCount).toBe(1);
    expect(metrics.overdueCallbacksCount).toBe(1);
    // SLA evaluated over ENQ-OCT-CONV (met), ENQ-OCT-OPEN (met), ENQ-DUE-TODAY-CONTACTED (met), ENQ-OVERDUE (missed), ENQ-NOV-CONV (met)
    expect(metrics.slaEvaluatedCount).toBe(5);
    expect(metrics.slaMetCount).toBe(4);
    expect(metrics.slaMetPct).toBe(80);
    expect(metrics.overdueSlaCount).toBe(1);
  });

  it('evaluates first-contact SLA against the earliest contactLog timestamp when contactLog is in newest-first order (R342)', () => {
    const newestFirstEnquiry = makeEnquiry({
      id: 'ENQ-NEWEST-FIRST',
      receivedAt: '2026-11-03T09:00:00Z',
      status: 'In contact',
      firstContactDueAt: '2026-11-03T17:30:00Z',
      // logEnquiryContact unshifts newest entries to index 0:
      // index 0 is a late follow-up on 5 Nov; index 1 is the on-time first contact on 3 Nov at 11:00
      contactLog: [
        {
          id: 'CL-FOLLOWUP-LATE',
          at: '2026-11-05T15:00:00Z',
          byId: 'P-1',
          method: 'Call',
          outcome: 'Spoke',
          note: 'Follow-up call after SLA deadline',
        },
        {
          id: 'CL-FIRST-ONTIME',
          at: '2026-11-03T11:00:00Z',
          byId: 'P-1',
          method: 'Call',
          outcome: 'Spoke',
          note: 'Initial callback within SLA',
        },
      ],
    });

    const metrics = computeEnquiryDashboardMetrics([newestFirstEnquiry], '2026-11-09T12:00:00Z');
    expect(metrics.slaEvaluatedCount).toBe(1);
    expect(metrics.slaMetCount).toBe(1);
    expect(metrics.slaMetPct).toBe(100);
  });

  it('starts a new enquiry form with privacyNoticeGiven = false ("No") and validateEnquiryInput rejects missing privacyNoticeGiven (R347)', () => {
    const initialForm = extractEnquiryFormInitialState(null);
    expect(initialForm.privacyNoticeGiven).toBe(false);

    const validationErrors = validateEnquiryInput({
      channelId: 'enquiry_channel.phone',
      firstName: 'Alex',
      lastName: 'Morgan',
      phone: '01632 960101',
      practiceAreaId: 'work_type.real_estate_and_property',
      summary: 'Purchase of residential freehold',
      urgencyId: 'enquiry_urgency.standard',
      privacyNoticeGiven: initialForm.privacyNoticeGiven,
    });
    expect(validationErrors.privacyNoticeGiven).toBe(
      'Please confirm the privacy notice was read or sent to the caller.',
    );
  });

  it('uses Europe/London calendar dates for month/today bucketing while comparing firstContactDueAt against the real nowIso instant during BST (R360)', () => {
    // 2026-07-01T23:30:00Z is 00:30 BST on 2026-07-02 in Europe/London
    const nowIso = '2026-07-01T23:30:00Z';
    expect(formatLondonDateIso(nowIso)).toBe('2026-07-02');

    // 1. Received at 2026-06-30T23:30:00Z (00:30 BST on 1 July) -> falls in July (2026-07)
    //    Due at 2026-07-02T08:00:00Z (09:00 BST on 2 July) -> due today in London, NOT overdue at 00:30 BST
    const bstEnquiry = makeEnquiry({
      id: 'ENQ-BST-JULY',
      receivedAt: '2026-06-30T23:30:00Z',
      status: 'Assigned',
      firstContactDueAt: '2026-07-02T08:00:00Z',
      contactLog: [],
    });

    const metrics = computeEnquiryDashboardMetrics([bstEnquiry], nowIso);
    expect(metrics.todayIso).toBe('2026-07-02');
    expect(metrics.currentMonthKey).toBe('2026-07');
    expect(metrics.monthReceivedCount).toBe(1);
    expect(metrics.monthEnquiries.map((e) => e.id)).toEqual(['ENQ-BST-JULY']);
    expect(metrics.callbacksDueTodayCount).toBe(1);
    expect(metrics.overdueCallbacksCount).toBe(0);
    expect(metrics.overdueSlaCount).toBe(0);
    expect(metrics.slaEvaluatedCount).toBe(0);
    expect(metrics.slaMetPct).toBeNull();
  });

  it('filterEnquiriesForPracticeAreasAndTeams scopes enquiries to practiceAreaIds and teamIds without falling back to all enquiries when both are empty (R361)', () => {
    const enqProperty = makeEnquiry({
      id: 'ENQ-PA-PROP',
      practiceAreaId: 'work_type.real_estate_and_property',
      assignedTeamId: 'TM-PROP',
    });
    const enqCorporateOnPropTeam = makeEnquiry({
      id: 'ENQ-CORP-ON-PROP-TEAM',
      practiceAreaId: 'work_type.corporate_and_commercial',
      assignedTeamId: 'TM-PROP',
    });
    const enqDisputes = makeEnquiry({
      id: 'ENQ-PA-DISP',
      practiceAreaId: 'work_type.dispute_resolution_and_litigation',
      assignedTeamId: 'TM-DISP',
    });
    const all = [enqProperty, enqCorporateOnPropTeam, enqDisputes];

    // (a) User with no practice areas or teams -> empty list and hasScope === false
    const noScope = filterEnquiriesForPracticeAreasAndTeams(all, [], []);
    expect(noScope.hasScope).toBe(false);
    expect(noScope.enquiries).toEqual([]);

    // (b) User with teams only (no team practice areas) -> matches enquiries assigned to those teams
    const teamOnlyScope = filterEnquiriesForPracticeAreasAndTeams(all, [], ['TM-PROP']);
    expect(teamOnlyScope.hasScope).toBe(true);
    expect(teamOnlyScope.enquiries.map((e) => e.id)).toEqual([
      'ENQ-PA-PROP',
      'ENQ-CORP-ON-PROP-TEAM',
    ]);

    // (c) User with practice areas only -> matches enquiries in those practice areas
    const paOnlyScope = filterEnquiriesForPracticeAreasAndTeams(
      all,
      ['work_type.dispute_resolution_and_litigation'],
      [],
    );
    expect(paOnlyScope.hasScope).toBe(true);
    expect(paOnlyScope.enquiries.map((e) => e.id)).toEqual(['ENQ-PA-DISP']);

    // (d) Enquiry assigned to the user's team in another practice area is included alongside practice-area matches
    const combinedScope = filterEnquiriesForPracticeAreasAndTeams(
      all,
      ['work_type.real_estate_and_property'],
      ['TM-PROP'],
    );
    expect(combinedScope.hasScope).toBe(true);
    expect(combinedScope.enquiries.map((e) => e.id)).toEqual([
      'ENQ-PA-PROP',
      'ENQ-CORP-ON-PROP-TEAM',
    ]);
  });

  it('saveEnquiryRecord rejects non-draft saves without privacyNoticeGiven while leaving store.enquiries unchanged, allows draft saves to store privacyNoticeGiven = false, and allows legacy non-draft enquiries with privacyNoticeGiven = false to be edited and fixed (R362, R376, R380)', async () => {
    const store = getStore();
    const channelId =
      valueBySystemKey(store.values, 'enquiry_channel', 'phone')?.id ??
      'enquiry_channel.phone';
    const practiceAreaId =
      valueBySystemKey(store.values, 'work_type', 'real_estate_and_property')?.id ??
      'work_type.real_estate_and_property';
    const urgencyId =
      valueBySystemKey(store.values, 'enquiry_urgency', 'standard')?.id ??
      'enquiry_urgency.standard';

    const beforeEnquiriesSnapshot = structuredClone(store.enquiries);

    // 1. Non-draft save with privacyNoticeGiven omitted is rejected on the server and leaves store.enquiries unchanged
    const omittedNonDraft = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Elin',
        lastName: 'Bryn',
        phone: '01632 960222',
        practiceAreaId,
        summary: 'Residential purchase enquiry',
        notes: 'Caller enquiring about conveyancing fees.',
        urgencyId,
      },
      { byId: 'P-000018', asDraft: false },
    );
    expect(omittedNonDraft.enquiry).toBeUndefined();
    expect(omittedNonDraft.errors?.privacyNoticeGiven).toBe(
      'Please confirm the privacy notice was read or sent to the caller.',
    );
    expect(getStore().enquiries).toEqual(beforeEnquiriesSnapshot);

    // 2. Non-draft save with privacyNoticeGiven: false is rejected on the server and leaves store.enquiries unchanged
    const falseNonDraft = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Elin',
        lastName: 'Bryn',
        phone: '01632 960222',
        practiceAreaId,
        summary: 'Residential purchase enquiry',
        notes: 'Caller enquiring about conveyancing fees.',
        urgencyId,
        privacyNoticeGiven: false,
      },
      { byId: 'P-000018', asDraft: false },
    );
    expect(falseNonDraft.enquiry).toBeUndefined();
    expect(falseNonDraft.errors?.privacyNoticeGiven).toBe(
      'Please confirm the privacy notice was read or sent to the caller.',
    );
    expect(getStore().enquiries).toEqual(beforeEnquiriesSnapshot);

    // 3. Draft save with privacyNoticeGiven omitted succeeds and stores privacyNoticeGiven: false
    const draftSaved = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Elin',
        lastName: 'Bryn',
        phone: '01632 960222',
        practiceAreaId,
        summary: 'Draft residential purchase enquiry',
        notes: 'Draft notes.',
        urgencyId,
      },
      { byId: 'P-000018', asDraft: true },
    );
    expect(draftSaved.errors).toBeUndefined();
    expect(draftSaved.enquiry).toBeDefined();
    expect(draftSaved.enquiry?.status).toBe('Draft');
    expect(draftSaved.enquiry?.privacyNoticeGiven).toBe(false);

    // 4. Routing that draft to non-draft without privacyNoticeGiven: true is rejected and leaves store.enquiries unchanged
    const afterDraftSnapshot = structuredClone(getStore().enquiries);
    const routeDraftWithoutPrivacy = await saveEnquiryRecord(
      {
        notes: 'Attempting to route draft without privacy notice.',
        privacyNoticeGiven: false,
      },
      { id: draftSaved.enquiry!.id, byId: 'P-000018', asDraft: false },
    );
    expect(routeDraftWithoutPrivacy.enquiry).toBeUndefined();
    expect(routeDraftWithoutPrivacy.errors?.privacyNoticeGiven).toBe(
      'Please confirm the privacy notice was read or sent to the caller.',
    );
    expect(getStore().enquiries).toEqual(afterDraftSnapshot);

    // 5. Legacy non-draft enquiry stored with privacyNoticeGiven: false can be edited from its profile and fixed to privacyNoticeGiven: true
    const legacyEnquiry: Enquiry = {
      ...draftSaved.enquiry!,
      id: 'ENQ-LEGACY-PRIVACY',
      reference: 'ENQ-LEGACY-PRIVACY',
      status: 'New',
      privacyNoticeGiven: false,
    };
    getStore().enquiries.unshift(legacyEnquiry);

    const editedLegacy = await saveEnquiryRecord(
      {
        notes: 'Updated notes on legacy enquiry before confirming privacy notice.',
        privacyNoticeGiven: false,
      },
      { id: 'ENQ-LEGACY-PRIVACY', byId: 'P-000018' },
    );
    expect(editedLegacy.errors).toBeUndefined();
    expect(editedLegacy.enquiry?.notes).toBe(
      'Updated notes on legacy enquiry before confirming privacy notice.',
    );
    expect(editedLegacy.enquiry?.privacyNoticeGiven).toBe(false);

    const fixedLegacy = await saveEnquiryRecord(
      {
        notes: 'Updated notes and confirmed privacy notice given.',
        privacyNoticeGiven: true,
      },
      { id: 'ENQ-LEGACY-PRIVACY', byId: 'P-000018' },
    );
    expect(fixedLegacy.errors).toBeUndefined();
    expect(fixedLegacy.enquiry?.privacyNoticeGiven).toBe(true);

    // Once privacyNoticeGiven is true, unsetting it back to false is rejected and leaves store.enquiries unchanged
    const afterFixedSnapshot = structuredClone(getStore().enquiries);
    const revertPrivacy = await saveEnquiryRecord(
      {
        privacyNoticeGiven: false,
      },
      { id: 'ENQ-LEGACY-PRIVACY', byId: 'P-000018' },
    );
    expect(revertPrivacy.enquiry).toBeUndefined();
    expect(revertPrivacy.errors?.privacyNoticeGiven).toBe(
      'Please confirm the privacy notice was read or sent to the caller.',
    );
    expect(getStore().enquiries).toEqual(afterFixedSnapshot);
  });
});
