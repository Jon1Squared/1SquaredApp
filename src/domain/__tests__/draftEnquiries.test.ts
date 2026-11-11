import fs from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeDraftSaveBarState,
  computeEnquiryConflictSnapshot,
  detectPreliminaryConflicts,
  extractEnquiryFormInitialState,
  filterEnquiriesForTab,
  findEnquiryEntityMatches,
  formatConflictAlertLabel,
  getAvailableEnquiryActions,
  getEnquiryStagePeople,
  getMissingRoutingFields,
  isEnquiryFormDirty,
  mergePeopleWithEnquiries,
  runEnquiryConflictSearch,
} from '../enquiries';
import { resolveLabel } from '../lists';
import {
  assignEnquiryRecord,
  closeEnquiryRecord,
  logEnquiryContactRecord,
  prepareEnquiryConversion,
  saveCustomFieldDefinition,
  saveEnquiryRecord,
} from '@/server/services';
import { createSeedStore, getStore } from '@/server/store';
import { auditEntriesForRecord, markAuditPosition } from '@/server/testSupport/auditTestSupport';

describe('Draft enquiries and routing lifecycle (Phases 2–7)', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    global.__oneSquaredStore = createSeedStore(new Date('2026-10-18T09:00:00Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    global.__oneSquaredStore = undefined;
  });

  it('1. Save as draft sets status Draft and creates no task, no queue routing and no SLA target', async () => {
    const store = getStore();
    const initialTaskCount = store.tasks.length;
    const auditMark = await markAuditPosition();
    const channelId =
      store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Phone')?.id ?? '';
    const practiceAreaId =
      store.values.find((v) => v.listKey === 'work_type' && !v.parentId && v.active)?.id ?? '';

    const res = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Lisa',
        lastName: 'Kendall',
        phone: '07700 900412',
        practiceAreaId,
        summary: 'Draft enquiry in progress',
        notes: '',
      },
      { byId: 'P-000018', asDraft: true },
    );

    expect(res.errors).toBeUndefined();
    expect(res.enquiry).toBeDefined();
    const draft = res.enquiry!;

    expect(draft.status).toBe('Draft');
    expect(draft.assignedTeamId).toBeNull();
    expect(draft.assignedToId).toBeNull();
    expect(draft.firstContactDueAt).toBeNull();
    expect(res.routedTeamName).toBeUndefined();

    // No automatic callback task created
    expect(store.tasks.length).toBe(initialTaskCount);
    const linkedTasks = store.tasks.filter((t) =>
      t.linkedRecords.some((lr) => lr.recordType === 'enquiry' && lr.recordId === draft.id),
    );
    expect(linkedTasks).toHaveLength(0);

    // Server-side conflict snapshot is persisted on the draft and in the audit trail
    expect(draft.conflictStatus).toBeDefined();
    expect(draft.conflictSnapshot).toBeDefined();
    const draftAudits = (await auditEntriesForRecord('enquiry', draft.id, auditMark)).filter(
      (a) => a.recordType === 'enquiry' && a.recordId === draft.id,
    );
    expect(draftAudits.some((a) => a.field === 'Enquiry saved as draft')).toBe(true);
    expect(
      draftAudits.some(
        (a) => a.field === 'Quick conflict check recorded' && Boolean(a.snapshot),
      ),
    ).toBe(true);
  });

  it('2. Save and route on a complete draft sets status New, creates the callback task, routes to the team and sets the SLA from the routing time', async () => {
    vi.useFakeTimers();
    try {
      // Create draft at 10:00 on Sunday 18 Oct 2026
      vi.setSystemTime(new Date('2026-10-18T10:00:00.000Z'));
      const store = getStore();
      const channelId =
        store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Phone')?.id ?? '';
      const practiceArea =
        store.values.find(
          (v) => v.listKey === 'work_type' && !v.parentId && v.label.includes('Employment'),
        ) ?? store.values.find((v) => v.listKey === 'work_type' && !v.parentId && v.active)!;
      const practiceAreaId = practiceArea.id;
      const urgentUrgencyId =
        store.values.find((v) => v.listKey === 'enquiry_urgency' && v.label === 'Urgent')?.id ??
        '';
      const auditMark = await markAuditPosition();

      const draftRes = await saveEnquiryRecord(
        {
          channelId,
          firstName: 'Evan',
          lastName: 'Pritchard',
          phone: '07700 900555',
          practiceAreaId,
          urgencyId: urgentUrgencyId,
          summary: 'Unfair dismissal advice',
          notes: '',
        },
        { byId: 'P-000018', asDraft: true },
      );

      const draft = draftRes.enquiry!;
      expect(draft.status).toBe('Draft');
      expect(draft.firstContactDueAt).toBeNull();

      // Route the draft 2 days later on Wednesday 21 Oct 2026 at 11:00
      const routeTime = new Date('2026-10-21T11:00:00.000Z');
      vi.setSystemTime(routeTime);

      const routedRes = await saveEnquiryRecord(
        {
          channelId,
          firstName: 'Evan',
          lastName: 'Pritchard',
          phone: '07700 900555',
          practiceAreaId,
          urgencyId: urgentUrgencyId,
          summary: 'Unfair dismissal advice',
          notes: 'Caller dismissed after 4 years of service, wants representation.',
          privacyNoticeGiven: true,
        },
        { id: draft.id, byId: 'P-000018', asDraft: false },
      );

      expect(routedRes.errors).toBeUndefined();
      const routed = routedRes.enquiry!;
      expect(routed.status).toBe('New');
      expect(routed.assignedTeamId).not.toBeNull();
      expect(routedRes.routedTeamName).toBeDefined();

      // SLA target calculated from routing time (Wednesday 21 Oct → same-day end 2026-10-21T17:30),
      // NOT from draft creation time (18 Oct)
      expect(routed.firstContactDueAt).not.toBeNull();
      expect(routed.firstContactDueAt?.startsWith('2026-10-21')).toBe(true);

      // Callback task created for the routed enquiry
      const linkedTasks = store.tasks.filter((t) =>
        t.linkedRecords.some((lr) => lr.recordType === 'enquiry' && lr.recordId === routed.id),
      );
      expect(linkedTasks).toHaveLength(1);
      expect(linkedTasks[0].autoTrigger).toBe('enquiry_contact');

      // Audit trail records routing to practice area team
      const audits = (await auditEntriesForRecord('enquiry', routed.id, auditMark)).filter(
        (a) => a.recordType === 'enquiry' && a.recordId === routed.id,
      );
      expect(audits.some((a) => a.field?.startsWith('Enquiry routed to '))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('3. Save and route on an incomplete draft does not save, and returns the list of missing fields', async () => {
    const store = getStore();
    const channelId =
      store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Phone')?.id ?? '';

    const draftRes = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Lisa',
        lastName: 'Kendall',
        phone: '',
        email: '',
        practiceAreaId: '',
        summary: '',
        notes: '',
      },
      { byId: 'P-000018', asDraft: true },
    );

    const draft = draftRes.enquiry!;
    const savedUpdatedAt = draft.updatedAt;

    // Attempt to save and route while missing contact, practice area, and summary
    const routeAttempt = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Lisa',
        lastName: 'Kendall',
        phone: '',
        email: '',
        practiceAreaId: '',
        summary: '',
        notes: 'Modified notes that should not be saved on failed route',
      },
      { id: draft.id, byId: 'P-000018', asDraft: false },
    );

    expect(routeAttempt.enquiry).toBeUndefined();
    expect(routeAttempt.errors).toBeDefined();
    expect(routeAttempt.missingFields).toEqual([
      'phone or email',
      'practice area',
      'summary',
    ]);

    // Verify the stored draft was NOT mutated or routed
    const storedDraft = store.enquiries.find((e) => e.id === draft.id)!;
    expect(storedDraft.status).toBe('Draft');
    expect(storedDraft.notes).toBe('');
    expect(storedDraft.updatedAt).toBe(savedUpdatedAt);
    expect(
      store.tasks.filter((t) =>
        t.linkedRecords.some((lr) => lr.recordType === 'enquiry' && lr.recordId === draft.id),
      ),
    ).toHaveLength(0);

    // Save bar state shows "Still needed" pill and missing field names
    const saveBar = computeDraftSaveBarState({
      isDirty: true,
      justSaved: false,
      attemptedRouteWithMissing: true,
      missingFields: getMissingRoutingFields({
        firstName: 'Lisa',
        lastName: 'Kendall',
        phone: '',
        email: '',
        practiceAreaId: '',
        summary: '',
        notes: '',
      }),
      lastSavedAtFormatted: '18 Oct 2026, 16:38',
      lastSavedByName: 'Siân Llewellyn',
    });
    expect(saveBar.pillLabel).toBe('Still needed');
    expect(saveBar.pillTone).toBe('alert');
    expect(saveBar.message).toContain(
      'phone or email, practice area, summary, enquiry notes',
    );
  });

  it('4. Reopening a draft loads every field correctly, including How they heard about us and Privacy notice given', async () => {
    const store = getStore();
    const channelId =
      store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Email')?.id ?? '';
    const practiceAreaId =
      store.values.find((v) => v.listKey === 'work_type' && !v.parentId && v.active)?.id ?? '';
    const subcatId =
      store.values.find((v) => v.listKey === 'work_type' && v.parentId === practiceAreaId)?.id ??
      '';
    const prefContactId =
      store.values.find((v) => v.listKey === 'contact_method' && v.label === 'Email')?.id ?? '';
    const originId =
      store.values.find((v) => v.listKey === 'origin' && v.active)?.id ?? '';
    const urgencyId =
      store.values.find((v) => v.listKey === 'enquiry_urgency' && v.label === 'Urgent')?.id ?? '';
    const countryId =
      store.values.find((v) => v.listKey === 'country' && v.label === 'United Kingdom')?.id ??
      null;

    const draftRes = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Morgan',
        lastName: 'Bevan',
        callingOnBehalfOf: 'Castell Homes Ltd',
        sourceId: originId,
        privacyNoticeGiven: true,
        linkedPersonId: 'P-000001',
        linkedOrganisationId: 'O-000001',
        phone: '029 2010 4400',
        email: 'morgan@castellhomes.co.uk',
        preferredContactMethodId: prefContactId,
        bestTimeToCall: 'After 3pm',
        address: {
          id: 'addr_1',
          typeId: null,
          line1: '12 Park Place',
          line2: 'Suite 4',
          town: 'Cardiff',
          county: 'South Glamorgan',
          postcode: 'CF10 1AA',
          countryId,
        },
        practiceAreaId,
        workTypeSubcategoryId: subcatId,
        summary: 'Director service contract review',
        notes: 'Detailed background notes from initial call',
        otherPartiesNamed: 'Bay Retail Group Ltd',
        urgencyId,
        keyDate: '2026-11-15',
      },
      { byId: 'P-000018', asDraft: true },
    );

    const savedDraft = draftRes.enquiry!;
    const loadedState = extractEnquiryFormInitialState(savedDraft, {
      channelId: 'fallback-ch',
      urgencyId: 'fallback-urg',
      countryId: null,
    });

    expect(loadedState).toEqual({
      channelId,
      firstName: 'Morgan',
      lastName: 'Bevan',
      callingOnBehalfOf: 'Castell Homes Ltd',
      sourceId: originId,
      privacyNoticeGiven: true,
      linkedPersonId: 'P-000001',
      linkedOrganisationId: 'O-000001',
      phone: '029 2010 4400',
      email: 'morgan@castellhomes.co.uk',
      preferredContactMethodId: prefContactId,
      bestTimeToCall: 'After 3pm',
      postcode: 'CF10 1AA',
      line1: '12 Park Place',
      line2: 'Suite 4',
      town: 'Cardiff',
      county: 'South Glamorgan',
      countryId,
      practiceAreaId,
      workTypeSubcategoryId: subcatId,
      summary: 'Director service contract review',
      notes: 'Detailed background notes from initial call',
      otherPartiesNamed: 'Bay Retail Group Ltd',
      urgencyId,
      keyDate: '2026-11-15',
    });
  });

  it('5. Editing a field in a draft re-runs the conflict check and shows "Unsaved changes"', async () => {
    const store = getStore();
    const channelId =
      store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Phone')?.id ?? '';

    const clientOrg = store.organisations.find((o) =>
      store.matters.some((m) => m.clientId === o.id),
    )!;
    expect(clientOrg).toBeDefined();

    // Create a clean draft with no conflicts
    const draftRes = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Jane',
        lastName: 'UnmatchedCaller',
        phone: '07700 911222',
      },
      { byId: 'P-000018', asDraft: true },
    );

    const draft = draftRes.enquiry!;
    expect(draft.conflictStatus).toBe('Clear');
    expect(draft.conflictSnapshot?.conflicts).toHaveLength(0);

    const baseline = extractEnquiryFormInitialState(draft, {
      channelId,
      urgencyId: draft.urgencyId,
      countryId: null,
    });

    // Initially clean: shows "Draft" pill
    expect(isEnquiryFormDirty(baseline, baseline)).toBe(false);
    const initialBar = computeDraftSaveBarState({
      isDirty: false,
      justSaved: false,
      attemptedRouteWithMissing: false,
      missingFields: ['practice area', 'summary', 'enquiry notes'],
      lastSavedAtFormatted: '18 Oct 2026, 16:38',
      lastSavedByName: 'Siân Llewellyn',
    });
    expect(initialBar.pillLabel).toBe('Draft');
    expect(initialBar.message).toContain('Last saved 18 Oct 2026, 16:38 by Siân Llewellyn.');

    // Edit otherPartiesNamed to name an existing client organisation
    const editedState = {
      ...baseline,
      otherPartiesNamed: clientOrg.legalName,
    };

    expect(isEnquiryFormDirty(editedState, baseline)).toBe(true);

    // Save bar transitions to "Unsaved changes"
    const dirtyBar = computeDraftSaveBarState({
      isDirty: isEnquiryFormDirty(editedState, baseline),
      justSaved: false,
      attemptedRouteWithMissing: false,
      missingFields: ['practice area', 'summary', 'enquiry notes'],
      lastSavedAtFormatted: '18 Oct 2026, 16:38',
      lastSavedByName: 'Siân Llewellyn',
    });
    expect(dirtyBar.pillLabel).toBe('Unsaved changes');
    expect(dirtyBar.pillTone).toBe('warning');

    // Live conflict check re-runs on the edited field and detects the conflict
    const liveConflicts = detectPreliminaryConflicts(
      {
        firstName: editedState.firstName,
        lastName: editedState.lastName,
        callingOnBehalfOf: editedState.callingOnBehalfOf,
        otherPartiesNamed: editedState.otherPartiesNamed,
        email: editedState.email,
        phone: editedState.phone,
      },
      store.people,
      store.organisations,
      store.matters,
      store.values,
      [],
      null,
      [],
      undefined,
      'not-a-law-firm',
    );
    expect(liveConflicts.length).toBeGreaterThan(0);
    expect(liveConflicts.some((h) => h.severity === 'high' && h.blocking)).toBe(true);

    const updatedSnapshot = computeEnquiryConflictSnapshot(
      {
        firstName: editedState.firstName,
        lastName: editedState.lastName,
        callingOnBehalfOf: editedState.callingOnBehalfOf,
        otherPartiesNamed: editedState.otherPartiesNamed,
        email: editedState.email,
        phone: editedState.phone,
      },
      store.people,
      store.organisations,
      store.matters,
      store.values,
      {
        recordedAt: '2026-10-18T16:40:00.000Z',
        recordedById: 'P-000018',
        tenantId: 'not-a-law-firm',
      },
    );
    expect(updatedSnapshot.conflictStatus).toBe('Possible conflict');
  });

  it('6. Take / Assign / Convert to matter are not available on a Draft', async () => {
    const store = getStore();
    const channelId =
      store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Phone')?.id ?? '';

    const draftRes = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Lisa',
        lastName: 'Kendall',
        phone: '07700 900412',
      },
      { byId: 'P-000018', asDraft: true },
    );
    const draft = draftRes.enquiry!;

    // UI action availability helper blocks Take, Assign, and Convert to matter on a Draft
    const draftActions = getAvailableEnquiryActions(draft, 'P-000012');
    expect(draftActions).not.toContain('Take');
    expect(draftActions).not.toContain('Assign');
    expect(draftActions).not.toContain('Convert to matter');
    expect(draftActions).toEqual(['Decline', 'Save changes', 'Save and route enquiry']);

    // Server actions also reject Assign and Convert to matter on a Draft
    const assignAttempt = await assignEnquiryRecord(draft.id, 'P-000012', null, 'P-000012');
    expect(assignAttempt.error).toMatch(/Cannot assign a draft/i);

    const convertAttempt = await prepareEnquiryConversion(draft.id, {}, 'P-000012');
    expect(convertAttempt.ok).toBe(false);
    expect(convertAttempt.conflictReasons?.[0]).toMatch(/Cannot convert a draft enquiry/i);
  });

  it('7. Drafts do not appear in team queues but do appear in "My drafts"', async () => {
    const store = getStore();
    const channelId =
      store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Phone')?.id ?? '';
    const practiceAreaId =
      store.values.find((v) => v.listKey === 'work_type' && !v.parentId && v.active)?.id ?? '';

    const draftRes = await saveEnquiryRecord(
      {
        channelId,
        takenById: 'P-000018',
        firstName: 'Draft',
        lastName: 'Caller',
        phone: '07700 900999',
        practiceAreaId,
      },
      { byId: 'P-000018', asDraft: true },
    );
    const draft = draftRes.enquiry!;

    const myTeamIds = new Set(['TM-000005', 'TM-000006']);

    // Appears in "My drafts" for the user who created/took it
    const myDrafts = filterEnquiriesForTab(store.enquiries, 'drafts', 'P-000018', myTeamIds);
    expect(myDrafts.some((e) => e.id === draft.id)).toBe(true);

    // Does NOT appear in team queues ('team'), 'mine', or 'open'
    for (const tab of ['team', 'mine', 'open'] as const) {
      const list = filterEnquiriesForTab(store.enquiries, tab, 'P-000018', myTeamIds);
      expect(list.some((e) => e.id === draft.id)).toBe(false);
    }
  });

  it('8. The conflict alert shows each record ID once', () => {
    const store = getStore();
    const oppStatusId =
      store.values.find(
        (v) => v.listKey === 'relationship_status' && v.label === 'Opposite Party',
      )?.id ?? '';

    // Clone an existing person template and set as Opposite Party person Lisa Kendall (P-000026)
    const templatePerson = store.people[0];
    store.people.push({
      ...templatePerson,
      id: 'P-000026',
      firstName: 'Lisa',
      middleNames: '',
      surname: 'Kendall',
      preferredName: '',
      relationshipStatusId: oppStatusId,
      isEmployee: false,
      emails: [{ id: 'em_lk', address: 'lisa.kendall@example.com', typeId: null, isPrimary: true }],
      phones: [],
      addresses: [],
      mergedIntoId: null,
    });

    const check = runEnquiryConflictSearch(
      {
        firstName: 'Lisa',
        lastName: 'Kendall',
        callingOnBehalfOf: '',
        otherPartiesNamed: '',
      },
      store.people,
      store.organisations,
      store.matters,
      store.values,
      [],
      null,
      [],
      undefined,
      'not-a-law-firm',
    );

    const hit = check.clientAgainstPartyMatches.find((h) => h.recordId === 'P-000026');
    expect(hit).toBeDefined();

    const formatted = formatConflictAlertLabel(hit!);
    expect(formatted).toBe('Lisa Kendall (P-000026)');
    expect(formatted).not.toContain('(P-000026) (P-000026)');
  });

  it('9. Enquiry-stage people appear in the people list, convert to a Person on matter conversion, and are removed on Declined / Referred out / No response', async () => {
    const store = getStore();
    const channelId =
      store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Phone')?.id ?? '';
    const practiceAreaId =
      store.values.find((v) => v.listKey === 'work_type' && !v.parentId && v.active)?.id ?? '';
    const declineReasonId =
      store.values.find((v) => v.listKey === 'enquiry_close_reason' && v.active)?.id ?? '';

    // 1. Add a routed enquiry for a new person -> appears in getEnquiryStagePeople
    const saved = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Nia',
        lastName: 'Gwynne',
        email: 'nia.gwynne@example.com',
        phone: '07700 900777',
        practiceAreaId,
        summary: 'Leasehold extension advice',
        notes: 'Caller owns flat with 78 years remaining on lease.',
        privacyNoticeGiven: true,
      },
      { byId: 'P-000018', asDraft: false },
    );
    const enq1 = saved.enquiry!;
    expect(enq1.linkedPersonId).toBeNull();

    let stageList = getEnquiryStagePeople(store.enquiries, store.people, store.values);
    expect(stageList.some((p) => p.enquiryId === enq1.id && p.displayName === 'Nia Gwynne')).toBe(
      true,
    );

    // 2. Convert the enquiry -> creates a Person record and removes the duplicate enquiry-stage row
    const conv = await prepareEnquiryConversion(enq1.id, {}, 'P-000001');
    expect(conv.ok).toBe(true);
    expect(enq1.linkedPersonId).toBeTruthy();
    expect(store.people.some((p) => p.id === enq1.linkedPersonId)).toBe(true);

    stageList = getEnquiryStagePeople(store.enquiries, store.people, store.values);
    expect(stageList.some((p) => p.enquiryId === enq1.id)).toBe(false);

    // 3. Declined enquiry removes the enquiry person from the people list
    const savedDecline = (await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Owen',
        lastName: 'Meredith',
        phone: '07700 900778',
        practiceAreaId,
        summary: 'Boundary wall dispute',
        notes: 'Wants neighbour dispute representation.',
        privacyNoticeGiven: true,
      },
      { byId: 'P-000018', asDraft: false },
    )).enquiry!;

    expect(
      getEnquiryStagePeople(store.enquiries, store.people, store.values).some(
        (p) => p.enquiryId === savedDecline.id,
      ),
    ).toBe(true);

    await closeEnquiryRecord(
      savedDecline.id,
      { targetStatus: 'Declined', closeReasonId: declineReasonId },
      'P-000001',
    );
    expect(
      getEnquiryStagePeople(store.enquiries, store.people, store.values).some(
        (p) => p.enquiryId === savedDecline.id,
      ),
    ).toBe(false);

    // 4. Referred out enquiry removes the enquiry person from the people list
    const savedRefer = (await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Teleri',
        lastName: 'Vaughan',
        phone: '07700 900779',
        practiceAreaId,
        summary: 'Criminal defence enquiry',
        notes: 'Outside firm practice areas.',
        privacyNoticeGiven: true,
      },
      { byId: 'P-000018', asDraft: false },
    )).enquiry!;

    expect(
      getEnquiryStagePeople(store.enquiries, store.people, store.values).some(
        (p) => p.enquiryId === savedRefer.id,
      ),
    ).toBe(true);

    await closeEnquiryRecord(
      savedRefer.id,
      { targetStatus: 'Referred out', referredToName: 'Cardiff Defence Chambers' },
      'P-000001',
    );
    expect(
      getEnquiryStagePeople(store.enquiries, store.people, store.values).some(
        (p) => p.enquiryId === savedRefer.id,
      ),
    ).toBe(false);

    // 5. Closed (No response) enquiry removes the enquiry person from the people list
    const savedNoResp = (await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Iwan',
        lastName: 'Prosser',
        phone: '07700 900780',
        practiceAreaId,
        summary: 'Residential purchase quote',
        notes: 'Left message requesting conveyancing quote.',
        privacyNoticeGiven: true,
      },
      { byId: 'P-000018', asDraft: false },
    )).enquiry!;

    await logEnquiryContactRecord(
      savedNoResp.id,
      { method: 'Phone', outcome: 'No answer', note: 'Attempt 1' },
      'P-000001',
    );
    await logEnquiryContactRecord(
      savedNoResp.id,
      { method: 'Phone', outcome: 'Left Voicemail', note: 'Attempt 2' },
      'P-000001',
    );
    await closeEnquiryRecord(savedNoResp.id, { targetStatus: 'No response' }, 'P-000001');
    expect(
      getEnquiryStagePeople(store.enquiries, store.people, store.values).some(
        (p) => p.enquiryId === savedNoResp.id,
      ),
    ).toBe(false);
  });

  it('9. People details saved in enquiries are included in person lookups, duplicate checks, and quick/full conflict checks', async () => {
    const store = getStore();
    const channelId =
      store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Phone')?.id ?? '';
    const practiceAreaId =
      store.values.find((v) => v.listKey === 'work_type' && !v.parentId && v.active)?.id ?? '';

    const savedEnq = (await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Gethin',
        lastName: 'Maddox',
        email: 'gethin.maddox@example.com',
        phone: '07700 900891',
        callingOnBehalfOf: 'Maddox Marine Services Ltd',
        otherPartiesNamed: 'Brynfor Logistics Ltd, Seren Talbot',
        practiceAreaId,
        summary: 'Commercial lease dispute',
        notes: 'Seeking representation against landlord.',
      },
      { byId: 'P-000018', asDraft: true },
    )).enquiry!;

    // 1. mergePeopleWithEnquiries includes Gethin Maddox as a synthetic Person record
    const mergedPeople = mergePeopleWithEnquiries(store.people, store.enquiries, store.values);
    const gethinRecord = mergedPeople.find((p) => p.id === savedEnq.id);
    expect(gethinRecord).toBeDefined();
    expect(gethinRecord?.firstName).toBe('Gethin');
    expect(gethinRecord?.surname).toBe('Maddox');

    // 2. findEnquiryEntityMatches finds Gethin Maddox from enquiries when adding a person or enquiry
    const entityMatches = findEnquiryEntityMatches(
      {
        firstName: 'Gethin',
        lastName: 'Maddox',
        email: 'gethin.maddox@example.com',
      },
      store.people,
      store.organisations,
      store.enquiries,
    );
    expect(entityMatches.people.some((m) => m.person.id === savedEnq.id)).toBe(true);

    // 3. Quick conflict check flags when a new caller matches an other party named on an existing enquiry
    const conflictWhenCallerIsEnqOtherParty = detectPreliminaryConflicts(
      {
        firstName: 'Seren',
        lastName: 'Talbot',
      },
      store.people,
      store.organisations,
      store.matters,
      store.values,
      store.enquiries,
      null,
      [],
      undefined,
      'not-a-law-firm',
    );
    expect(
      conflictWhenCallerIsEnqOtherParty.some((h) => h.recordId === savedEnq.id),
    ).toBe(true);

    // 4. Quick conflict check flags when an other party on a new form matches an enquiry caller
    const conflictWhenOtherPartyIsEnqCaller = detectPreliminaryConflicts(
      {
        firstName: 'New',
        lastName: 'Caller',
        otherPartiesNamed: 'Gethin Maddox',
      },
      store.people,
      store.organisations,
      store.matters,
      store.values,
      store.enquiries,
      null,
      [],
      undefined,
      'not-a-law-firm',
    );
    expect(
      conflictWhenOtherPartyIsEnqCaller.some((h) => h.recordId === savedEnq.id),
    ).toBe(true);
  });

  it('11. Client-configured custom fields on the Enquiry screen support screen locations and mandatory validation', async () => {
    const store = getStore();
    const channelId =
      store.values.find((v) => v.listKey === 'enquiry_channel' && v.label === 'Phone')?.id ?? '';
    const practiceAreaId =
      store.values.find((v) => v.listKey === 'work_type' && !v.parentId && v.active)?.id ?? '';

    const mandatoryCallerField = await saveCustomFieldDefinition(
      {
        recordType: 'enquiry',
        label: 'Referral campaign code',
        fieldType: 'text',
        section: 'enquiry_caller',
        required: true,
      },
      'P-000018',
    );
    const optionalDetailsField = await saveCustomFieldDefinition(
      {
        recordType: 'enquiry',
        label: 'Legal aid eligibility checked',
        fieldType: 'yesNo',
        section: 'enquiry_details',
        required: false,
      },
      'P-000018',
    );

    // Routing without the mandatory custom field fails and lists the missing field
    const blocked = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Carys',
        lastName: 'Pritchard',
        phone: '07700 900555',
        practiceAreaId,
        summary: 'Commercial lease review',
        notes: 'Caller requested urgent review of heads of terms.',
        privacyNoticeGiven: true,
        customFields: {},
      },
      { byId: 'P-000018', asDraft: false },
    );

    expect(blocked.enquiry).toBeUndefined();
    expect(blocked.missingFields).toContain('referral campaign code');
    expect(blocked.errors?.[mandatoryCallerField.id]).toBe(
      'Referral campaign code is required',
    );

    // Completing the mandatory custom field routes and persists customFields on the Enquiry
    const routed = await saveEnquiryRecord(
      {
        channelId,
        firstName: 'Carys',
        lastName: 'Pritchard',
        phone: '07700 900555',
        practiceAreaId,
        summary: 'Commercial lease review',
        notes: 'Caller requested urgent review of heads of terms.',
        privacyNoticeGiven: true,
        customFields: {
          [mandatoryCallerField.id]: 'CMP-2026-Q4',
          [optionalDetailsField.id]: true,
        },
      },
      { byId: 'P-000018', asDraft: false },
    );

    expect(routed.errors).toBeUndefined();
    expect(routed.enquiry?.customFields).toEqual({
      [mandatoryCallerField.id]: 'CMP-2026-Q4',
      [optionalDetailsField.id]: true,
    });
  });
});
