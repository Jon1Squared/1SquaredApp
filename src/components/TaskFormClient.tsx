'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { saveTaskAction } from '@/app/actions';
import { enquiryDisplayName } from '@/domain/enquiries';
import { personDisplayName } from '@/domain/names';
import type {
  ChoiceValue,
  Enquiry,
  Matter,
  Organisation,
  Person,
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
  values: ChoiceValue[];
  currentUserId: string;
  initialLinkedRecord?: TaskLinkedRecord | null;
  initialTeamId?: string | null;
}

export function TaskFormClient({
  people,
  organisations,
  matters,
  enquiries,
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
  const [linkRecordType, setLinkRecordType] = useState<TaskLinkedRecordType>('matter');
  const [linkRecordId, setLinkRecordId] = useState('');

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
      employees.find((e) => e.id === 'P-000003') ??
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

  const availableRecordsForType = useMemo(() => {
    if (linkRecordType === 'enquiry') {
      return enquiries.map((e) => ({
        id: e.id,
        label: `${e.reference} — ${enquiryDisplayName(e)} (${e.summary})`,
      }));
    }
    if (linkRecordType === 'matter') {
      return matters.map((m) => ({
        id: m.id,
        label: `${m.matterNumber} — ${m.title || 'Untitled matter'}`,
      }));
    }
    if (linkRecordType === 'person') {
      return people
        .filter((p) => !p.mergedIntoId)
        .map((p) => ({
          id: p.id,
          label: `${personDisplayName(p)} (${p.id})`,
        }));
    }
    return organisations
      .filter((o) => !o.mergedIntoId)
      .map((o) => ({
        id: o.id,
        label: `${o.legalName} (${o.id})`,
      }));
  }, [linkRecordType, enquiries, matters, people, organisations]);

  const resolveLinkedLabel = (lr: TaskLinkedRecord) => {
    if (lr.recordType === 'enquiry') {
      const e = enquiries.find((x) => x.id === lr.recordId);
      return e ? `Enquiry: ${e.reference} (${enquiryDisplayName(e)})` : `Enquiry: ${lr.recordId}`;
    }
    if (lr.recordType === 'matter') {
      const m = matters.find((x) => x.id === lr.recordId);
      return m
        ? `Matter: ${m.matterNumber} — ${m.title || 'Untitled matter'}`
        : `Matter: ${lr.recordId}`;
    }
    if (lr.recordType === 'person') {
      const p = people.find((x) => x.id === lr.recordId);
      return p ? `Person: ${personDisplayName(p)}` : `Person: ${lr.recordId}`;
    }
    const o = organisations.find((x) => x.id === lr.recordId);
    return o ? `Organisation: ${o.legalName}` : `Organisation: ${lr.recordId}`;
  };

  const handleAddLink = () => {
    if (!linkRecordId) return;
    if (
      linkedRecords.some(
        (lr) => lr.recordType === linkRecordType && lr.recordId === linkRecordId,
      )
    ) {
      return;
    }
    setLinkedRecords((prev) => [...prev, { recordType: linkRecordType, recordId: linkRecordId }]);
    setLinkRecordId('');
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
                {linkedRecords.map((lr) => (
                  <span key={`${lr.recordType}-${lr.recordId}`} className="tag-chip">
                    {resolveLinkedLabel(lr)}
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
                ))}
              </div>
            ) : null}
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr auto', gap: 8 }}>
              <select
                className="field-select"
                aria-label="Linked record type"
                value={linkRecordType}
                onChange={(e) => {
                  setLinkRecordType(e.target.value as TaskLinkedRecordType);
                  setLinkRecordId('');
                }}
              >
                <option value="matter">Matter</option>
                <option value="enquiry">Enquiry</option>
                <option value="person">Person</option>
                <option value="organisation">Organisation</option>
              </select>
              <select
                className="field-select"
                aria-label="Select record to link"
                value={linkRecordId}
                onChange={(e) => setLinkRecordId(e.target.value)}
              >
                <option value="">Select record…</option>
                {availableRecordsForType.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={handleAddLink}
              >
                Add link
              </button>
            </div>
          </div>
        }
      />
    </div>
  );
}
