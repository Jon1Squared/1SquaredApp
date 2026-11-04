'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { saveTaskAction } from '@/app/actions';
import { enquiryDisplayName } from '@/domain/enquiries';
import { personDisplayName, primaryEmail, primaryPhone, recordHref } from '@/domain/names';
import { quoteClientDisplayName, quoteWorkTypeSummary } from '@/domain/quotes';
import type {
  ChoiceValue,
  Enquiry,
  Matter,
  Organisation,
  Person,
  Quote,
  TaskLinkedRecord,
  TaskLinkedRecordType,
  Team,
} from '@/domain/types';
import {
  CreateTaskModal,
  type CreateTaskSubmitPayload,
  type SuggestedTaskAssignee,
} from './CreateTaskModal';
import { useToast } from './Toast';

interface Props {
  teams: Team[];
  people: Person[];
  organisations: Organisation[];
  matters: Matter[];
  enquiries: Enquiry[];
  quotes?: Quote[];
  values: ChoiceValue[];
  currentUserId: string;
  initialLinkedRecord?: TaskLinkedRecord | null;
  initialTeamId?: string | null;
}

interface SearchableRecordItem {
  recordType: TaskLinkedRecordType;
  recordId: string;
  typeLabel: 'Matter' | 'Enquiry' | 'Quote' | 'Organisation' | 'Person';
  reference: string;
  title: string;
  subtitle: string;
  href: string;
  searchText: string;
}

export function TaskFormClient({
  people,
  organisations,
  matters,
  enquiries,
  quotes = [],
  values,
  currentUserId,
  initialLinkedRecord,
  initialTeamId,
}: Props) {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const employees = useMemo(
    () =>
      people
        .filter((p) => p.isEmployee && !p.mergedIntoId && !p.demo)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );

  const [linkedRecords, setLinkedRecords] = useState<TaskLinkedRecord[]>(
    initialLinkedRecord ? [initialLinkedRecord] : [],
  );
  const [recordSearchQuery, setRecordSearchQuery] = useState('');
  const [recordSearchFocused, setRecordSearchFocused] = useState(false);

  // Build suggested people based on linked matter/enquiry or current user's team
  const suggestedPeople = useMemo<SuggestedTaskAssignee[]>(() => {
    const seen = new Set<string>();
    const list: SuggestedTaskAssignee[] = [];
    const addPerson = (personId: string | null | undefined, badgeLabel: string) => {
      if (!personId || seen.has(personId)) return;
      const emp = employees.find((e) => e.id === personId) ?? people.find((p) => p.id === personId);
      if (!emp || !emp.isEmployee) return;
      seen.add(personId);
      list.push({ person: emp, badgeLabel });
    };

    const linkedMatterRec = linkedRecords.find((lr) => lr.recordType === 'matter');
    const linkedMatter = linkedMatterRec
      ? matters.find((m) => m.id === linkedMatterRec.recordId)
      : null;

    if (linkedMatter) {
      addPerson(linkedMatter.leadFeeEarnerId, 'Fee earner');
      addPerson(
        linkedMatter.supervisingPartnerId || linkedMatter.responsiblePartnerId,
        'Supervising partner',
      );
      if (
        linkedMatter.responsiblePartnerId &&
        linkedMatter.responsiblePartnerId !== linkedMatter.supervisingPartnerId
      ) {
        addPerson(linkedMatter.responsiblePartnerId, 'Responsible partner');
      }
      for (const tid of linkedMatter.teamMemberIds ?? []) {
        const emp = employees.find((e) => e.id === tid);
        addPerson(tid, emp?.employment?.jobTitle || emp?.jobTitle || 'Team member');
      }
    } else {
      addPerson(currentUserId, 'Fee earner');
      const currentEmp = employees.find((e) => e.id === currentUserId);
      if (currentEmp?.employment?.supervisingPartnerId) {
        addPerson(currentEmp.employment.supervisingPartnerId, 'Supervising partner');
      }
    }

    const colpEmp =
      employees.find((e) => e.employeeRoleId === 'employee_role.risk_and_compliance') ??
      employees.find((e) =>
        (e.employment?.jobTitle || e.jobTitle || '').toLowerCase().includes('colp'),
      );
    if (colpEmp) addPerson(colpEmp.id, 'COLP');

    const practiceMgrEmp = employees.find((e) =>
      (e.employment?.jobTitle || e.jobTitle || '').toLowerCase().includes('practice manager'),
    );
    if (practiceMgrEmp) addPerson(practiceMgrEmp.id, 'Practice manager');

    return list;
  }, [linkedRecords, matters, employees, people, currentUserId]);

  const searchableRecords = useMemo<SearchableRecordItem[]>(() => {
    const items: SearchableRecordItem[] = [];

    for (const m of matters) {
      const clientOrg = organisations.find((o) => o.id === m.clientId);
      const clientPerson = people.find((p) => p.id === m.clientId);
      const clientName = clientOrg
        ? clientOrg.legalName
        : clientPerson
          ? personDisplayName(clientPerson)
          : '';
      const title = m.title || 'Untitled matter';
      items.push({
        recordType: 'matter',
        recordId: m.id,
        typeLabel: 'Matter',
        reference: m.matterNumber,
        title: `${m.matterNumber} — ${title}`,
        subtitle: clientName,
        href: `/matters/${m.id}`,
        searchText: `matter ${m.matterNumber} ${m.id} ${title} ${clientName}`.toLowerCase(),
      });
    }

    for (const e of enquiries) {
      const name = enquiryDisplayName(e, 'Unnamed enquiry');
      items.push({
        recordType: 'enquiry',
        recordId: e.id,
        typeLabel: 'Enquiry',
        reference: e.reference,
        title: `${e.reference} — ${name}`,
        subtitle: e.summary || '',
        href: `/enquiries/${e.id}`,
        searchText: `enquiry ${e.reference} ${e.id} ${name} ${e.callingOnBehalfOf ?? ''} ${e.summary ?? ''} ${e.email ?? ''} ${e.phone ?? ''}`.toLowerCase(),
      });
    }

    for (const q of quotes) {
      const clientName = quoteClientDisplayName(q, people, organisations);
      const workSummary = quoteWorkTypeSummary(q, values);
      items.push({
        recordType: 'quote',
        recordId: q.id,
        typeLabel: 'Quote',
        reference: q.reference,
        title: `${q.reference} — ${clientName}`,
        subtitle: q.scope || workSummary,
        href: `/quotes/${q.id}`,
        searchText: `quote ${q.reference} ${q.id} ${clientName} ${q.prospectName ?? ''} ${q.prospectOrganisationName ?? ''} ${q.prospectEmail ?? ''} ${q.prospectPhone ?? ''} ${q.scope ?? ''} ${workSummary}`.toLowerCase(),
      });
    }

    for (const o of organisations) {
      if (o.mergedIntoId) continue;
      const trading = (o.otherNames ?? []).map((n) => n.name).join(', ');
      items.push({
        recordType: 'organisation',
        recordId: o.id,
        typeLabel: 'Organisation',
        reference: o.id,
        title: o.legalName,
        subtitle: [trading, o.companyNumber ? `Co. ${o.companyNumber}` : '', o.generalEmail]
          .filter(Boolean)
          .join(' · '),
        href: `/organisations/${o.id}`,
        searchText: `organisation organization ${o.legalName} ${o.id} ${trading} ${o.companyNumber ?? ''} ${o.generalEmail ?? ''}`.toLowerCase(),
      });
    }

    for (const p of people) {
      if (p.mergedIntoId) continue;
      const name = personDisplayName(p);
      const email = primaryEmail(p);
      const phone = primaryPhone(p);
      items.push({
        recordType: 'person',
        recordId: p.id,
        typeLabel: 'Person',
        reference: p.id,
        title: name,
        subtitle: [email, phone].filter(Boolean).join(' · '),
        href: `/people/${p.id}`,
        searchText: `person ${name} ${p.id} ${email} ${phone}`.toLowerCase(),
      });
    }

    return items;
  }, [matters, enquiries, quotes, organisations, people, values]);

  const matchingSearchRecords = useMemo(() => {
    const tokens = recordSearchQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) return [];

    return searchableRecords
      .filter((item) => {
        if (
          linkedRecords.some(
            (lr) => lr.recordType === item.recordType && lr.recordId === item.recordId,
          )
        ) {
          return false;
        }
        return tokens.every((tok) => item.searchText.includes(tok));
      })
      .slice(0, 12);
  }, [recordSearchQuery, searchableRecords, linkedRecords]);

  const resolveLinkedItem = (lr: TaskLinkedRecord) => {
    const found = searchableRecords.find(
      (item) => item.recordType === lr.recordType && item.recordId === lr.recordId,
    );
    if (found) {
      return {
        typeLabel: found.typeLabel,
        label: found.title,
        href: found.href,
      };
    }
    const typeLabel =
      lr.recordType.charAt(0).toUpperCase() + lr.recordType.slice(1);
    return {
      typeLabel,
      label: lr.recordId,
      href: recordHref({ id: lr.recordId, recordType: lr.recordType }),
    };
  };

  const handleSelectRecord = (item: Pick<SearchableRecordItem, 'recordType' | 'recordId'>) => {
    setLinkedRecords((prev) => {
      if (
        prev.some(
          (lr) => lr.recordType === item.recordType && lr.recordId === item.recordId,
        )
      ) {
        return prev;
      }
      return [...prev, { recordType: item.recordType, recordId: item.recordId }];
    });
    setRecordSearchQuery('');
  };

  const handleSubmit = (payload: CreateTaskSubmitPayload) => {
    startTransition(async () => {
      const res = await saveTaskAction({
        title: payload.title,
        description: payload.details || undefined,
        dueAt: payload.dueAtIso,
        assignedTeamId: initialTeamId || null,
        assignedPersonId: payload.assignedPersonIds[0] ?? null,
        assignedPersonIds: payload.assignedPersonIds,
        multiAssigneeMode: payload.multiAssigneeMode,
        linkedRecords,
      });
      if (res.error || !res.task) {
        showToast(res.error ?? 'Could not save task');
        return;
      }
      showToast(`Created ${res.task.reference}`);
      router.push(`/tasks/${res.task.id}`);
    });
  };

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 640, marginBottom: 12 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          <Link href="/tasks">← Back to Tasks</Link>
        </div>
      </div>

      <CreateTaskModal
        embeddedAsPage
        headerTitle="Create task"
        headerSubtitle="Create a task and assign it to one or more people."
        peopleSectionLabel={
          linkedRecords.some((lr) => lr.recordType === 'matter')
            ? 'PEOPLE ON THIS MATTER'
            : 'SUGGESTED PEOPLE'
        }
        initialTaskName=""
        taskNamePlaceholder="e.g. New matter submission for [MATTER NAME]"
        suggestedPeople={suggestedPeople}
        initialSelectedPersonIds={[currentUserId]}
        employees={employees}
        values={values}
        defaultDueHoursFromNow={48}
        submitting={pending}
        submitLabel="Create task"
        onClose={() => router.push('/tasks')}
        onSubmit={handleSubmit}
        extraFieldsSlot={
          <div
            style={{
              borderTop: '1px solid #e2e8f0',
              paddingTop: 12,
            }}
          >
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 700,
                color: '#0f172a',
                marginBottom: 8,
              }}
            >
              Linked records (optional)
            </div>
            {linkedRecords.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {linkedRecords.map((lr) => {
                  const info = resolveLinkedItem(lr);
                  return (
                    <span
                      key={`${lr.recordType}-${lr.recordId}`}
                      className="tag-chip"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.03em',
                          color: '#475569',
                        }}
                      >
                        {info.typeLabel}:
                      </span>
                      <Link
                        href={info.href}
                        style={{ color: 'inherit', textDecoration: 'underline' }}
                      >
                        {info.label}
                      </Link>
                      <button
                        type="button"
                        aria-label={`Remove ${lr.recordId}`}
                        onClick={() =>
                          setLinkedRecords((prev) =>
                            prev.filter(
                              (x) =>
                                !(x.recordType === lr.recordType && x.recordId === lr.recordId),
                            ),
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : null}

            <div style={{ position: 'relative' }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Search
                  size={15}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 10,
                    color: '#64748b',
                    pointerEvents: 'none',
                  }}
                />
                <input
                  type="search"
                  className="field-input"
                  aria-label="Search linked records"
                  placeholder="Search for a matter, enquiry, quote, organisation or person…"
                  style={{ paddingLeft: 32, width: '100%' }}
                  value={recordSearchQuery}
                  onFocus={() => setRecordSearchFocused(true)}
                  onBlur={() => {
                    // Delay closing slightly so mousedown/click on a result item registers
                    setTimeout(() => setRecordSearchFocused(false), 150);
                  }}
                  onChange={(e) => setRecordSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && matchingSearchRecords.length > 0) {
                      e.preventDefault();
                      handleSelectRecord(matchingSearchRecords[0]);
                    }
                  }}
                />
              </div>

              {recordSearchQuery.trim().length > 0 && recordSearchFocused ? (
                <div
                  role="listbox"
                  aria-label="Matching records"
                  style={{
                    marginTop: 4,
                    border: '1px solid #cbd5e1',
                    borderRadius: 8,
                    background: '#ffffff',
                    boxShadow: '0 8px 20px rgba(15, 23, 42, 0.08)',
                    maxHeight: 260,
                    overflowY: 'auto',
                  }}
                >
                  {matchingSearchRecords.length === 0 ? (
                    <div
                      className="muted"
                      style={{ padding: '10px 12px', fontSize: 12.5 }}
                    >
                      No matching matters, enquiries, quotes, organisations or people found.
                    </div>
                  ) : (
                    matchingSearchRecords.map((item) => (
                      <div
                        key={`${item.recordType}-${item.recordId}`}
                        role="option"
                        aria-selected={false}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          handleSelectRecord(item);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          padding: '8px 12px',
                          borderBottom: '1px solid #f1f5f9',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              fontSize: 13,
                              fontWeight: 600,
                              color: '#0f172a',
                            }}
                          >
                            <span
                              style={{
                                fontSize: 10.5,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: '#f1f5f9',
                                color: '#334155',
                                flexShrink: 0,
                              }}
                            >
                              {item.typeLabel}
                            </span>
                            <span
                              style={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {item.title}
                            </span>
                          </div>
                          {item.subtitle ? (
                            <div
                              className="muted"
                              style={{
                                fontSize: 11.5,
                                marginTop: 2,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {item.subtitle}
                            </div>
                          ) : null}
                        </div>
                        <span
                          className="btn btn--secondary btn--sm"
                          style={{ flexShrink: 0, pointerEvents: 'none' }}
                        >
                          + Add link
                        </span>
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          </div>
        }
      />
    </div>
  );
}
