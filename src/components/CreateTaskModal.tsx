'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { resolveLabel } from '@/domain/lists';
import { initials, personDisplayName } from '@/domain/names';
import { resolveOrgDepartment } from '@/domain/orgStructure';
import type { ChoiceValue, Person } from '@/domain/types';

export interface SuggestedTaskAssignee {
  person: Person;
  badgeLabel: string;
}

export interface CreateTaskSubmitPayload {
  title: string;
  details: string;
  assignedPersonIds: string[];
  multiAssigneeMode: 'shared' | 'separate';
  dueAtIso: string;
}

interface CreateTaskModalProps {
  open?: boolean;
  embeddedAsPage?: boolean;
  headerTitle?: string;
  headerSubtitle?: string;
  peopleSectionLabel?: string;
  initialTaskName?: string;
  taskNamePlaceholder?: string;
  suggestedPeople: SuggestedTaskAssignee[];
  initialSelectedPersonIds?: string[];
  employees: Person[];
  values: ChoiceValue[];
  defaultDueHoursFromNow?: number;
  submitting?: boolean;
  submitLabel?: string;
  extraFieldsSlot?: React.ReactNode;
  onClose: () => void;
  onSubmit: (payload: CreateTaskSubmitPayload) => void | Promise<void>;
}

function getDefaultDueLocal(hoursFromNow: number): string {
  const d = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

export function resolveEmployeeSubtitle(emp: Person, values: ChoiceValue[]): string {
  const jobTitle = emp.employment?.jobTitle?.trim() || emp.jobTitle?.trim() || 'Staff';
  const deptName =
    resolveOrgDepartment(emp.employment?.departmentId || emp.departmentId)?.name ||
    resolveLabel(values, emp.departmentId) ||
    '';
  return [jobTitle, deptName].filter(Boolean).join(' · ');
}

export function CreateTaskModal({
  open = true,
  embeddedAsPage = false,
  headerTitle = 'Create task',
  headerSubtitle = 'Create a task on this matter and assign it to one or more people.',
  peopleSectionLabel = 'PEOPLE ON THIS MATTER',
  initialTaskName = '',
  taskNamePlaceholder = 'New matter submission for [MATTER NAME]',
  suggestedPeople,
  initialSelectedPersonIds,
  employees,
  values,
  defaultDueHoursFromNow = 48,
  submitting = false,
  submitLabel = 'Create task',
  extraFieldsSlot,
  onClose,
  onSubmit,
}: CreateTaskModalProps) {
  const [taskName, setTaskName] = useState<string>(initialTaskName);
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>(
    () => initialSelectedPersonIds ?? [],
  );
  const [staffSearch, setStaffSearch] = useState<string>('');
  const [multiAssigneeMode, setMultiAssigneeMode] = useState<'shared' | 'separate'>('shared');
  const [furtherDetails, setFurtherDetails] = useState<string>('');
  const [dueAtLocal, setDueAtLocal] = useState<string>(() =>
    getDefaultDueLocal(defaultDueHoursFromNow),
  );

  // Reset modal state when opened
  useEffect(() => {
    if (!open) return;
    setTaskName(initialTaskName);
    setSelectedPersonIds(initialSelectedPersonIds ?? []);
    setStaffSearch('');
    setMultiAssigneeMode('shared');
    setFurtherDetails('');
    setDueAtLocal(getDefaultDueLocal(defaultDueHoursFromNow));
  }, [open, initialTaskName, initialSelectedPersonIds, defaultDueHoursFromNow]);

  const suggestedIds = useMemo(
    () => suggestedPeople.map((sp) => sp.person.id),
    [suggestedPeople],
  );

  const allSuggestedSelected =
    suggestedIds.length > 0 &&
    suggestedIds.every((id) => selectedPersonIds.includes(id));

  function togglePerson(personId: string) {
    setSelectedPersonIds((prev) =>
      prev.includes(personId)
        ? prev.filter((id) => id !== personId)
        : [...prev, personId],
    );
  }

  function handleSelectAllSuggested() {
    if (allSuggestedSelected) {
      setSelectedPersonIds((prev) => prev.filter((id) => !suggestedIds.includes(id)));
    } else {
      setSelectedPersonIds((prev) => Array.from(new Set([...prev, ...suggestedIds])));
    }
  }

  const staffSearchResults = useMemo(() => {
    const q = staffSearch.trim().toLowerCase();
    if (!q) return [];
    const suggestedSet = new Set(suggestedIds);
    return employees
      .filter((emp) => !emp.demo)
      .filter((emp) => {
        const name = personDisplayName(emp).toLowerCase();
        const jobTitle = (emp.employment?.jobTitle || emp.jobTitle || '').toLowerCase();
        const deptName = (
          resolveOrgDepartment(emp.employment?.departmentId || emp.departmentId)?.name ||
          resolveLabel(values, emp.departmentId) ||
          ''
        ).toLowerCase();
        const email = (emp.emails?.[0]?.address || '').toLowerCase();
        return (
          name.includes(q) ||
          jobTitle.includes(q) ||
          deptName.includes(q) ||
          email.includes(q)
        );
      })
      .sort((a, b) => {
        const aInSuggested = suggestedSet.has(a.id) ? 1 : 0;
        const bInSuggested = suggestedSet.has(b.id) ? 1 : 0;
        if (aInSuggested !== bInSuggested) return aInSuggested - bInSuggested;
        return personDisplayName(a).localeCompare(personDisplayName(b));
      })
      .slice(0, 8);
  }, [employees, staffSearch, suggestedIds, values]);

  const selectedPeopleObjects = useMemo(() => {
    const map = new Map<string, Person>();
    for (const sp of suggestedPeople) map.set(sp.person.id, sp.person);
    for (const emp of employees) map.set(emp.id, emp);
    return selectedPersonIds
      .map((id) => map.get(id))
      .filter((p): p is Person => Boolean(p));
  }, [selectedPersonIds, suggestedPeople, employees]);

  async function handleFormSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!taskName.trim() || selectedPersonIds.length === 0 || submitting) return;
    const parsedDue = dueAtLocal ? new Date(dueAtLocal) : null;
    const dueAtIso =
      parsedDue && !Number.isNaN(parsedDue.getTime())
        ? parsedDue.toISOString()
        : new Date(Date.now() + defaultDueHoursFromNow * 60 * 60 * 1000).toISOString();

    await onSubmit({
      title: taskName.trim(),
      details: furtherDetails.trim(),
      assignedPersonIds: selectedPersonIds,
      multiAssigneeMode,
      dueAtIso,
    });
  }

  if (!open && !embeddedAsPage) return null;

  const cardContent = (
    <div
      role={embeddedAsPage ? undefined : 'dialog'}
      aria-modal={embeddedAsPage ? undefined : 'true'}
      aria-labelledby="create-task-modal-title"
      style={{
        background: '#ffffff',
        borderRadius: 12,
        border: '1px solid #cbd5e1',
        boxShadow: embeddedAsPage
          ? '0 4px 16px rgba(15, 23, 42, 0.06)'
          : '0 24px 54px rgba(15, 23, 42, 0.22)',
        maxWidth: embeddedAsPage ? 640 : 540,
        width: '100%',
        maxHeight: embeddedAsPage ? undefined : '92vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* HEADER */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          padding: '18px 22px 16px',
          borderBottom: '1px solid #e2e8f0',
        }}
      >
        <div>
          <h2
            id="create-task-modal-title"
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 700,
              color: '#0f172a',
              lineHeight: 1.25,
            }}
          >
            {headerTitle}
          </h2>
          {headerSubtitle ? (
            <p
              style={{
                margin: '4px 0 0',
                fontSize: 12.5,
                color: '#64748b',
                lineHeight: 1.4,
              }}
            >
              {headerSubtitle}
            </p>
          ) : null}
        </div>
        {!embeddedAsPage ? (
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close modal"
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              cursor: 'pointer',
              color: '#475569',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
            }}
          >
            <X size={17} />
          </button>
        ) : null}
      </div>

      {/* SCROLLABLE BODY */}
      <div
        style={{
          padding: '18px 22px',
          overflowY: embeddedAsPage ? undefined : 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* TASK NAME */}
        <div>
          <label
            htmlFor="create-task-name-input"
            style={{
              display: 'block',
              fontSize: 13,
              fontWeight: 700,
              color: '#0f172a',
              marginBottom: 6,
            }}
          >
            Task name <span style={{ color: '#dc2626' }}>*</span>
          </label>
          <input
            id="create-task-name-input"
            type="text"
            value={taskName}
            onChange={(e) => setTaskName(e.target.value)}
            placeholder={taskNamePlaceholder}
            style={{
              width: '100%',
              padding: '9px 12px',
              fontSize: 13.5,
              color: '#0f172a',
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: 8,
              outline: 'none',
            }}
          />
        </div>

        {/* ASSIGN TO */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 6,
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: '#0f172a',
              }}
            >
              Assign to <span style={{ color: '#dc2626' }}>*</span>
            </span>
            <span
              style={{
                fontSize: 12,
                color: '#64748b',
                fontWeight: 500,
              }}
            >
              {selectedPersonIds.length === 1
                ? '1 person selected'
                : `${selectedPersonIds.length} people selected`}
            </span>
          </div>

          {/* PEOPLE ON THIS MATTER BOX */}
          {suggestedPeople.length > 0 ? (
            <div
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                overflow: 'hidden',
                background: '#ffffff',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '9px 14px',
                  background: '#f8fafc',
                  borderBottom: '1px solid #e2e8f0',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                    color: '#475569',
                  }}
                >
                  {peopleSectionLabel}
                </span>
                <button
                  type="button"
                  onClick={handleSelectAllSuggested}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#0d5c54',
                    cursor: 'pointer',
                  }}
                >
                  {allSuggestedSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gap: 10,
                  padding: '14px 12px',
                }}
              >
                {suggestedPeople.map(({ person, badgeLabel }) => {
                  const isChecked = selectedPersonIds.includes(person.id);
                  const dispName = personDisplayName(person);
                  const subtitle = resolveEmployeeSubtitle(person, values);
                  return (
                    <div
                      key={person.id}
                      role="checkbox"
                      aria-checked={isChecked}
                      tabIndex={0}
                      title={[dispName, badgeLabel, subtitle].filter(Boolean).join(' · ')}
                      onClick={() => togglePerson(person.id)}
                      onKeyDown={(e) => {
                        if (e.key === ' ' || e.key === 'Enter') {
                          e.preventDefault();
                          togglePerson(person.id);
                        }
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        textAlign: 'center',
                        gap: 6,
                        padding: '8px 6px',
                        borderRadius: 10,
                        background: isChecked ? '#f2f9f7' : 'transparent',
                        border: isChecked ? '1px solid #b5dfd5' : '1px solid transparent',
                        cursor: 'pointer',
                        transition: 'all 0.14s ease',
                      }}
                    >
                      {/* Initials Circle (highlighted when selected) */}
                      <div style={{ position: 'relative', display: 'inline-flex' }}>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 42,
                            height: 42,
                            borderRadius: '50%',
                            background: isChecked ? '#0d5c54' : '#e0f0ec',
                            color: isChecked ? '#ffffff' : '#0d5c54',
                            boxShadow: isChecked
                              ? '0 0 0 3px rgba(13, 92, 84, 0.22)'
                              : 'none',
                            fontSize: 13,
                            fontWeight: 700,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                            transition: 'all 0.14s ease',
                          }}
                        >
                          {initials(dispName)}
                        </span>
                        {isChecked ? (
                          <span
                            aria-hidden="true"
                            style={{
                              position: 'absolute',
                              right: -2,
                              bottom: -2,
                              width: 16,
                              height: 16,
                              borderRadius: '50%',
                              background: '#0d5c54',
                              border: '2px solid #ffffff',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Check size={9} color="#ffffff" strokeWidth={3.2} />
                          </span>
                        ) : null}
                      </div>

                      {/* Name & Role underneath */}
                      <div style={{ width: '100%', minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: isChecked ? 700 : 600,
                            color: isChecked ? '#0d5c54' : '#0f172a',
                            lineHeight: 1.25,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {dispName}
                        </div>
                        {badgeLabel ? (
                          <div
                            style={{
                              fontSize: 10.5,
                              fontWeight: 600,
                              color: isChecked ? '#0d5c54' : '#64748b',
                              lineHeight: 1.2,
                              marginTop: 2,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {badgeLabel}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        {/* ADD SOMEONE ELSE FROM THE FIRM */}
        <div>
          <label
            htmlFor="create-task-staff-search"
            style={{
              display: 'block',
              fontSize: 13,
              fontWeight: 700,
              color: '#0f172a',
              marginBottom: 6,
            }}
          >
            Add someone else from the firm
          </label>
          <div style={{ position: 'relative' }}>
            <Search
              size={15}
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#64748b',
                pointerEvents: 'none',
              }}
            />
            <input
              id="create-task-staff-search"
              type="text"
              value={staffSearch}
              onChange={(e) => setStaffSearch(e.target.value)}
              placeholder="Search staff by name, role or department"
              style={{
                width: '100%',
                padding: '9px 12px 9px 35px',
                fontSize: 13,
                color: '#0f172a',
                background: '#ffffff',
                border: '1px solid #cbd5e1',
                borderRadius: 8,
                outline: 'none',
              }}
            />
          </div>

          {staffSearch.trim().length > 0 ? (
            <div
              style={{
                marginTop: 6,
                border: '1px solid #e2e8f0',
                borderRadius: 8,
                maxHeight: 180,
                overflowY: 'auto',
                background: '#ffffff',
              }}
            >
              {staffSearchResults.length === 0 ? (
                <div
                  style={{
                    padding: '10px 12px',
                    fontSize: 12.5,
                    color: '#64748b',
                  }}
                >
                  No matching staff found.
                </div>
              ) : (
                staffSearchResults.map((emp, idx) => {
                  const isChecked = selectedPersonIds.includes(emp.id);
                  const dispName = personDisplayName(emp);
                  const subtitle = resolveEmployeeSubtitle(emp, values);
                  const roleBadge =
                    emp.employment?.jobTitle?.trim() ||
                    emp.jobTitle?.trim() ||
                    'Staff';
                  return (
                    <div
                      key={emp.id}
                      role="checkbox"
                      aria-checked={isChecked}
                      tabIndex={0}
                      onClick={() => togglePerson(emp.id)}
                      onKeyDown={(e) => {
                        if (e.key === ' ' || e.key === 'Enter') {
                          e.preventDefault();
                          togglePerson(emp.id);
                        }
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        padding: '8px 12px',
                        borderTop: idx === 0 ? 'none' : '1px solid #f1f5f9',
                        background: isChecked ? '#f2f9f7' : '#ffffff',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: 4,
                            border: isChecked
                              ? '1.5px solid #0d5c54'
                              : '1.5px solid #94a3b8',
                            background: isChecked ? '#0d5c54' : '#ffffff',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          {isChecked ? (
                            <Check size={11} color="#ffffff" strokeWidth={3} />
                          ) : null}
                        </span>
                        <span
                          aria-hidden="true"
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: '50%',
                            background: '#e0f0ec',
                            color: '#0d5c54',
                            fontSize: 11,
                            fontWeight: 700,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          {initials(dispName)}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
                            {dispName}
                          </div>
                          <div style={{ fontSize: 11.5, color: '#64748b' }}>{subtitle}</div>
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: '#0d5c54',
                          background: '#e0f0ec',
                          padding: '2px 8px',
                          borderRadius: 999,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {roleBadge}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
        </div>

        {/* ASSIGNED TO SUMMARY CARD */}
        <div
          style={{
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            padding: '12px 14px',
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: '#475569',
              marginBottom: 8,
            }}
          >
            Assigned to
          </div>

          {selectedPeopleObjects.length === 0 ? (
            <div style={{ fontSize: 12.5, color: '#64748b' }}>
              Select one or more people above to assign this task.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {selectedPeopleObjects.map((person) => {
                const dispName = personDisplayName(person);
                return (
                  <span
                    key={person.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px 4px 12px',
                      borderRadius: 999,
                      background: '#ffffff',
                      border: '1px solid #cbd5e1',
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: '#0f172a',
                    }}
                  >
                    <span>{dispName}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${dispName}`}
                      onClick={() => togglePerson(person.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        color: '#64748b',
                        display: 'inline-flex',
                        alignItems: 'center',
                        fontSize: 14,
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {selectedPeopleObjects.length > 1 ? (
            <div
              style={{
                borderTop: '1px solid #e2e8f0',
                marginTop: 12,
                paddingTop: 10,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#475569',
                  marginBottom: 8,
                }}
              >
                With more than one person
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    color: '#0f172a',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="create-task-multi-assignee-mode"
                    checked={multiAssigneeMode === 'shared'}
                    onChange={() => setMultiAssigneeMode('shared')}
                    style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                  />
                  <span>One shared task – done when anyone completes it</span>
                </label>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 13,
                    color: '#0f172a',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="radio"
                    name="create-task-multi-assignee-mode"
                    checked={multiAssigneeMode === 'separate'}
                    onChange={() => setMultiAssigneeMode('separate')}
                    style={{ accentColor: '#0d5c54', width: 15, height: 15 }}
                  />
                  <span>A separate task for each person</span>
                </label>
              </div>
            </div>
          ) : null}
        </div>

        {/* FURTHER DETAILS */}
        <div>
          <label
            htmlFor="create-task-further-details"
            style={{
              display: 'block',
              fontSize: 13,
              fontWeight: 700,
              color: '#0f172a',
              marginBottom: 6,
            }}
          >
            Further details
          </label>
          <textarea
            id="create-task-further-details"
            rows={3}
            value={furtherDetails}
            onChange={(e) => setFurtherDetails(e.target.value)}
            placeholder="Add any further context or instructions for the assignee(s)..."
            style={{
              width: '100%',
              padding: '9px 12px',
              fontSize: 13,
              color: '#0f172a',
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: 8,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
        </div>

        {/* DUE DATE (defaults to 48 hours from creation) */}
        <div>
          <label
            htmlFor="create-task-due-at"
            style={{
              display: 'block',
              fontSize: 12.5,
              fontWeight: 600,
              color: '#475569',
              marginBottom: 5,
            }}
          >
            Due date &amp; time{' '}
            <span style={{ fontWeight: 400, color: '#64748b' }}>
              (defaults to {defaultDueHoursFromNow} hours from creation)
            </span>
          </label>
          <input
            id="create-task-due-at"
            type="datetime-local"
            value={dueAtLocal}
            onChange={(e) => setDueAtLocal(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              fontSize: 13,
              color: '#0f172a',
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: 8,
            }}
          />
        </div>

        {extraFieldsSlot ? <div>{extraFieldsSlot}</div> : null}
      </div>

      {/* FOOTER */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 10,
          padding: '14px 22px',
          borderTop: '1px solid #e2e8f0',
          background: '#ffffff',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          style={{
            padding: '8px 20px',
            borderRadius: 999,
            border: '1px solid #cbd5e1',
            background: '#ffffff',
            color: '#0f172a',
            fontSize: 13.5,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleFormSubmit()}
          disabled={submitting || !taskName.trim() || selectedPersonIds.length === 0}
          style={{
            padding: '8px 22px',
            borderRadius: 999,
            border: '1px solid #0d5c54',
            background:
              submitting || !taskName.trim() || selectedPersonIds.length === 0
                ? '#94a3b8'
                : '#0d5c54',
            color: '#ffffff',
            fontSize: 13.5,
            fontWeight: 700,
            cursor:
              submitting || !taskName.trim() || selectedPersonIds.length === 0
                ? 'not-allowed'
                : 'pointer',
          }}
        >
          {submitting ? 'Creating…' : submitLabel}
        </button>
      </div>
    </div>
  );

  if (embeddedAsPage) {
    return cardContent;
  }

  return (
    <div
      className="modal-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1250,
        padding: 20,
      }}
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      {cardContent}
    </div>
  );
}
