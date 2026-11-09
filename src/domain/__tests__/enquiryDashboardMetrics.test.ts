import { describe, expect, it } from 'vitest';
import {
  computeEnquiryDashboardMetrics,
  extractEnquiryFormInitialState,
  validateEnquiryInput,
} from '../enquiries';
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

  it('starts a new enquiry form with privacyNoticeGiven = false ("No") and rejects saving a non-draft enquiry without privacyNoticeGiven (R347)', () => {
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
});
