'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  createRecordFromPmsAction,
  linkPmsRecordAction,
  rerunAutomaticPmsMatchingAction,
  unlinkPmsRecordAction,
} from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import { formatDate } from '@/domain/dates';
import { personDisplayName, primaryEmail } from '@/domain/names';
import {
  formatPmsAsAtLabel,
  isValidPmsAsAtDate,
  PMS_AS_AT_UNAVAILABLE_LABEL,
} from '@/domain/pms';
import type { Matter, Organisation, Person, PmsEntityType } from '@/domain/types';
import type { PmsAdminSnapshot } from '@/server/services';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  pmsAdmin: PmsAdminSnapshot;
  organisations: Organisation[];
  people: Person[];
  matters: Matter[];
}

type SubTab = 'organisations' | 'people' | 'employees' | 'matters';

const MATCHED_BY_LABELS: Record<string, string> = {
  auto_company_number: 'Auto (company number)',
  auto_email: 'Auto (email)',
  manual: 'Manual',
  seed: 'Initial demo link',
};

export function PmsLinksAdminSection({ pmsAdmin, organisations, people, matters }: Props) {
  const { showToast } = useToast();
  const [subTab, setSubTab] = useState<SubTab>('organisations');
  const [pending, startTransition] = useTransition();

  // Manual link selection per 1Squared record ID
  const [selectedPmsCodeBy1SqId, setSelectedPmsCodeBy1SqId] = useState<Record<string, string>>({});

  const activeOrgs = useMemo(
    () =>
      organisations
        .filter((o) => !o.mergedIntoId)
        .sort((a, b) => a.legalName.localeCompare(b.legalName)),
    [organisations],
  );
  const activePeople = useMemo(
    () =>
      people
        .filter((p) => !p.mergedIntoId && !p.isEmployee)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );
  const activeEmployees = useMemo(
    () =>
      people
        .filter((p) => !p.mergedIntoId && p.isEmployee)
        .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b))),
    [people],
  );
  const activeMatters = useMemo(
    () =>
      matters
        .filter((m) => !m.mergedIntoId)
        .sort((a, b) => a.matterNumber.localeCompare(b.matterNumber)),
    [matters],
  );

  const pmsOrgClients = useMemo(
    () => pmsAdmin.pmsClients.filter((c) => c.client_type === 'Organisation'),
    [pmsAdmin.pmsClients],
  );
  const pmsIndClients = useMemo(
    () => pmsAdmin.pmsClients.filter((c) => c.client_type === 'Individual'),
    [pmsAdmin.pmsClients],
  );

  const linksByType = useMemo(() => {
    const map: Record<PmsEntityType, typeof pmsAdmin.pmsLinks> = {
      organisation: [],
      person: [],
      employee: [],
      matter: [],
    };
    for (const l of pmsAdmin.pmsLinks) {
      map[l.entityType].push(l);
    }
    return map;
  }, [pmsAdmin.pmsLinks]);

  const handleLink = (entityType: PmsEntityType, onesquaredId: string, pmsCode: string) => {
    if (!pmsCode) return;
    startTransition(async () => {
      const res = await linkPmsRecordAction(entityType, onesquaredId, pmsCode);
      if (isActionDenied(res)) {
        showToast(res.message);
        return;
      }
      showToast(`Linked ${pmsCode} in 1Squared`);
    });
  };

  const handleUnlink = (linkId: string, pmsCode: string) => {
    startTransition(async () => {
      const res = await unlinkPmsRecordAction(linkId);
      if (isActionDenied(res)) {
        showToast(res.message);
        return;
      }
      showToast(`Unlinked ${pmsCode}`);
    });
  };

  const handleRerunAuto = () => {
    startTransition(async () => {
      const res = await rerunAutomaticPmsMatchingAction();
      if (isActionDenied(res)) {
        showToast(res.message);
        return;
      }
      showToast(`Re-ran automatic PMS matching (${res.totalLinks} links active)`);
    });
  };

  const handleCreateFromPms = (entityType: PmsEntityType, pmsCode: string, label: string) => {
    startTransition(async () => {
      const res = await createRecordFromPmsAction(entityType, pmsCode);
      if (isActionDenied(res)) {
        showToast(res.message);
        return;
      }
      if (!res.ok) {
        showToast(res.error ?? 'Could not create record from PMS');
        return;
      }
      showToast(`Created ${label} in 1Squared and linked to ${pmsCode}`);
    });
  };

  // Unlinked counts
  const linkedOrg1SqIds = new Set(linksByType.organisation.map((l) => l.onesquaredId));
  const linkedOrgPmsCodes = new Set(linksByType.organisation.map((l) => l.pmsCode));
  const unlinked1SqOrgs = activeOrgs.filter((o) => !linkedOrg1SqIds.has(o.id));
  const unlinkedPmsOrgs = pmsOrgClients.filter((c) => !linkedOrgPmsCodes.has(c.client_code));

  const linkedPerson1SqIds = new Set(linksByType.person.map((l) => l.onesquaredId));
  const linkedPersonPmsCodes = new Set(linksByType.person.map((l) => l.pmsCode));
  const unlinked1SqPeople = activePeople.filter((p) => !linkedPerson1SqIds.has(p.id));
  const unlinkedPmsPeople = pmsIndClients.filter((c) => !linkedPersonPmsCodes.has(c.client_code));

  const linkedEmp1SqIds = new Set(linksByType.employee.map((l) => l.onesquaredId));
  const linkedEmpPmsCodes = new Set(linksByType.employee.map((l) => l.pmsCode));
  const unlinked1SqEmps = activeEmployees.filter((p) => !linkedEmp1SqIds.has(p.id));
  const unlinkedPmsEmps = pmsAdmin.pmsFeeEarners.filter(
    (fe) => !linkedEmpPmsCodes.has(fe.fee_earner_id),
  );

  const linkedMatter1SqIds = new Set(linksByType.matter.map((l) => l.onesquaredId));
  const linkedMatterPmsCodes = new Set(linksByType.matter.map((l) => l.pmsCode));
  const unlinked1SqMatters = activeMatters.filter((m) => !linkedMatter1SqIds.has(m.id));
  const unlinkedPmsMatters = pmsAdmin.pmsMatters.filter(
    (pm) => !linkedMatterPmsCodes.has(pm.matter_code),
  );

  return (
    <div>
      <div className="list-section__header" style={{ marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
              Practice Management System (PMS) links
            </h2>
            <StatusPill
              label={
                isValidPmsAsAtDate(pmsAdmin.extractInfo.asAtDate)
                  ? `PMS · as at ${formatPmsAsAtLabel(pmsAdmin.extractInfo.asAtDate)}`
                  : `PMS · ${PMS_AS_AT_UNAVAILABLE_LABEL}`
              }
              tone="neutral"
            />
          </div>
          <p className="muted" style={{ marginTop: 6 }}>
            Matches 1Squared records to PMS client codes, fee earner codes and matter codes.
            Organisations match automatically on Companies House / registration number; individual
            clients and employees match on email. Manual links are never overwritten when automatic
            matching is re-run.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--secondary"
          disabled={pending}
          onClick={handleRerunAuto}
        >
          Re-run automatic matching
        </button>
      </div>

      {/* Sub-navigation */}
      <div className="tabs-bar" style={{ marginBottom: 20 }}>
        <button
          type="button"
          className={`tab-btn ${subTab === 'organisations' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('organisations')}
        >
          Organisations ({linksByType.organisation.length} linked · {unlinkedPmsOrgs.length} PMS
          unmatched)
        </button>
        <button
          type="button"
          className={`tab-btn ${subTab === 'people' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('people')}
        >
          Individual clients ({linksByType.person.length} linked · {unlinkedPmsPeople.length} PMS
          unmatched)
        </button>
        <button
          type="button"
          className={`tab-btn ${subTab === 'employees' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('employees')}
        >
          Fee earners ({linksByType.employee.length} linked · {unlinkedPmsEmps.length} PMS
          unmatched)
        </button>
        <button
          type="button"
          className={`tab-btn ${subTab === 'matters' ? 'tab-btn--active' : ''}`}
          onClick={() => setSubTab('matters')}
        >
          Matters ({linksByType.matter.length} linked · {unlinkedPmsMatters.length} PMS unmatched)
        </button>
      </div>

      {/* 1. ORGANISATIONS */}
      {subTab === 'organisations' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              Matched organisations ({linksByType.organisation.length})
            </div>
            {linksByType.organisation.length === 0 ? (
              <p className="muted">No organisations linked yet.</p>
            ) : (
              linksByType.organisation.map((link) => {
                const org = activeOrgs.find((o) => o.id === link.onesquaredId);
                const pmsClient = pmsOrgClients.find((c) => c.client_code === link.pmsCode);
                return (
                  <div key={link.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        {org ? (
                          <Link href={`/organisations/${org.id}`}>{org.legalName}</Link>
                        ) : (
                          link.onesquaredId
                        )}{' '}
                        <span className="muted">↔</span>{' '}
                        <strong>
                          {link.pmsCode} — {pmsClient?.client_name ?? 'PMS client'}
                        </strong>
                      </div>
                      <div className="list-row__meta">
                        Co. number: {org?.companyNumber || '—'} · PMS Co. number:{' '}
                        {pmsClient?.company_number || '—'} ·{' '}
                        {MATCHED_BY_LABELS[link.matchedBy] ?? link.matchedBy} · Linked{' '}
                        {formatDate(link.matchedAt)}
                      </div>
                    </div>
                    <div className="list-row__aside">
                      <StatusPill
                        label={MATCHED_BY_LABELS[link.matchedBy] ?? link.matchedBy}
                        tone={link.matchedBy === 'manual' ? 'warning' : 'positive'}
                      />
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={pending}
                        onClick={() => handleUnlink(link.id, link.pmsCode)}
                      >
                        Unlink
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              1Squared organisations not linked to PMS ({unlinked1SqOrgs.length})
            </div>
            {unlinked1SqOrgs.length === 0 ? (
              <p className="muted">All 1Squared organisations are linked.</p>
            ) : (
              unlinked1SqOrgs.map((org) => {
                const chosen = selectedPmsCodeBy1SqId[org.id] ?? '';
                return (
                  <div key={org.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        <Link href={`/organisations/${org.id}`}>{org.legalName}</Link>{' '}
                        <span className="muted">({org.id})</span>
                      </div>
                      <div className="list-row__meta">
                        Co. number: {org.companyNumber || 'None'} · Email:{' '}
                        {org.generalEmail || '—'}
                      </div>
                    </div>
                    <div className="list-row__aside" style={{ gap: 8 }}>
                      <select
                        aria-label={`Select PMS client for ${org.legalName}`}
                        className="field-select"
                        style={{ width: 280, fontSize: 13 }}
                        value={chosen}
                        onChange={(e) =>
                          setSelectedPmsCodeBy1SqId((prev) => ({
                            ...prev,
                            [org.id]: e.target.value,
                          }))
                        }
                      >
                        <option value="">Link to PMS client…</option>
                        {unlinkedPmsOrgs.map((c) => (
                          <option key={c.client_code} value={c.client_code}>
                            {c.client_code} — {c.client_name} ({c.company_number || 'no reg'})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={pending || !chosen}
                        onClick={() => handleLink('organisation', org.id, chosen)}
                      >
                        Link
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              PMS organisation clients not in 1Squared ({unlinkedPmsOrgs.length})
            </div>
            {unlinkedPmsOrgs.length === 0 ? (
              <p className="muted">
                Every PMS organisation client is linked to a 1Squared organisation.
              </p>
            ) : (
              unlinkedPmsOrgs.map((c) => (
                <div key={c.client_code} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      <strong>
                        {c.client_code} — {c.client_name}
                      </strong>
                    </div>
                    <div className="list-row__meta">
                      Co. number: {c.company_number || '—'} · Sector: {c.sector || '—'} ·
                      Postcode: {c.postcode || '—'}
                    </div>
                  </div>
                  <div className="list-row__aside">
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={pending}
                      onClick={() =>
                        handleCreateFromPms('organisation', c.client_code, c.client_name)
                      }
                    >
                      + Create in 1Squared
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 2. PEOPLE (INDIVIDUAL CLIENTS) */}
      {subTab === 'people' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              Matched individual clients ({linksByType.person.length})
            </div>
            {linksByType.person.length === 0 ? (
              <p className="muted">No individual clients linked yet.</p>
            ) : (
              linksByType.person.map((link) => {
                const person = activePeople.find((p) => p.id === link.onesquaredId);
                const pmsClient = pmsIndClients.find((c) => c.client_code === link.pmsCode);
                return (
                  <div key={link.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        {person ? (
                          <Link href={`/people/${person.id}`}>{personDisplayName(person)}</Link>
                        ) : (
                          link.onesquaredId
                        )}{' '}
                        <span className="muted">↔</span>{' '}
                        <strong>
                          {link.pmsCode} — {pmsClient?.client_name ?? 'PMS client'}
                        </strong>
                      </div>
                      <div className="list-row__meta">
                        1Squared email: {person ? primaryEmail(person) || '—' : '—'} · PMS email:{' '}
                        {pmsClient?.email || '—'} ·{' '}
                        {MATCHED_BY_LABELS[link.matchedBy] ?? link.matchedBy}
                      </div>
                    </div>
                    <div className="list-row__aside">
                      <StatusPill
                        label={MATCHED_BY_LABELS[link.matchedBy] ?? link.matchedBy}
                        tone={link.matchedBy === 'manual' ? 'warning' : 'positive'}
                      />
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={pending}
                        onClick={() => handleUnlink(link.id, link.pmsCode)}
                      >
                        Unlink
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              1Squared people not linked to PMS ({unlinked1SqPeople.length})
            </div>
            {unlinked1SqPeople.map((p) => {
              const chosen = selectedPmsCodeBy1SqId[p.id] ?? '';
              return (
                <div key={p.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      <Link href={`/people/${p.id}`}>{personDisplayName(p)}</Link>{' '}
                      <span className="muted">({p.id})</span>
                    </div>
                    <div className="list-row__meta">Email: {primaryEmail(p) || 'None'}</div>
                  </div>
                  <div className="list-row__aside" style={{ gap: 8 }}>
                    <select
                      aria-label={`Select PMS client for ${personDisplayName(p)}`}
                      className="field-select"
                      style={{ width: 280, fontSize: 13 }}
                      value={chosen}
                      onChange={(e) =>
                        setSelectedPmsCodeBy1SqId((prev) => ({
                          ...prev,
                          [p.id]: e.target.value,
                        }))
                      }
                    >
                      <option value="">Link to PMS individual client…</option>
                      {unlinkedPmsPeople.map((c) => (
                        <option key={c.client_code} value={c.client_code}>
                          {c.client_code} — {c.client_name} ({c.email || 'no email'})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={pending || !chosen}
                      onClick={() => handleLink('person', p.id, chosen)}
                    >
                      Link
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              PMS individual clients not in 1Squared ({unlinkedPmsPeople.length})
            </div>
            {unlinkedPmsPeople.length === 0 ? (
              <p className="muted">
                Every PMS individual client is linked to a 1Squared person.
              </p>
            ) : (
              unlinkedPmsPeople.map((c) => (
                <div key={c.client_code} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      <strong>
                        {c.client_code} — {c.client_name}
                      </strong>
                    </div>
                    <div className="list-row__meta">
                      Email: {c.email || '—'} · Phone: {c.phone || '—'} · Postcode:{' '}
                      {c.postcode || '—'}
                    </div>
                  </div>
                  <div className="list-row__aside">
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={pending}
                      onClick={() => handleCreateFromPms('person', c.client_code, c.client_name)}
                    >
                      + Create in 1Squared
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 3. EMPLOYEES / FEE EARNERS */}
      {subTab === 'employees' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              Matched employees &amp; PMS fee earners ({linksByType.employee.length})
            </div>
            {linksByType.employee.map((link) => {
              const emp = activeEmployees.find((p) => p.id === link.onesquaredId);
              const fe = pmsAdmin.pmsFeeEarners.find((f) => f.fee_earner_id === link.pmsCode);
              const feFullName = fe ? `${fe.first_name} ${fe.last_name}` : 'PMS fee earner';
              return (
                <div key={link.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      {emp ? (
                        <Link href={`/people/${emp.id}`}>{personDisplayName(emp)}</Link>
                      ) : (
                        link.onesquaredId
                      )}{' '}
                      <span className="muted">↔</span>{' '}
                      <strong>
                        {link.pmsCode} — {feFullName}
                      </strong>
                    </div>
                    <div className="list-row__meta">
                      Email: {fe?.email || '—'} · Grade: {fe?.grade || '—'} · Dept:{' '}
                      {fe?.department || '—'} · Standard rate: £{fe?.standard_hourly_rate ?? 0}/hr
                    </div>
                  </div>
                  <div className="list-row__aside">
                    <StatusPill
                      label={MATCHED_BY_LABELS[link.matchedBy] ?? link.matchedBy}
                      tone={link.matchedBy === 'manual' ? 'warning' : 'positive'}
                    />
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={pending}
                      onClick={() => handleUnlink(link.id, link.pmsCode)}
                    >
                      Unlink
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              PMS fee earners not in 1Squared ({unlinkedPmsEmps.length})
            </div>
            {unlinkedPmsEmps.length === 0 ? (
              <p className="muted">All PMS fee earners are linked to 1Squared employees.</p>
            ) : (
              unlinkedPmsEmps.map((fe) => {
                const feFullName = `${fe.first_name} ${fe.last_name}`;
                return (
                  <div key={fe.fee_earner_id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        <strong>
                          {fe.fee_earner_id} — {feFullName}
                        </strong>{' '}
                        <StatusPill label={fe.grade} tone="neutral" />
                      </div>
                      <div className="list-row__meta">
                        {fe.department} · {fe.email} · Standard rate £{fe.standard_hourly_rate}/hr
                      </div>
                    </div>
                    <div className="list-row__aside">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={pending}
                        onClick={() =>
                          handleCreateFromPms('employee', fe.fee_earner_id, feFullName)
                        }
                      >
                        + Create in 1Squared
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              1Squared employees without a PMS fee earner code ({unlinked1SqEmps.length})
            </div>
            {unlinked1SqEmps.map((emp) => {
              const chosen = selectedPmsCodeBy1SqId[emp.id] ?? '';
              return (
                <div key={emp.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      <Link href={`/people/${emp.id}`}>{personDisplayName(emp)}</Link>{' '}
                      <span className="muted">({emp.id})</span>
                    </div>
                    <div className="list-row__meta">
                      {emp.jobTitle || 'Employee'} · {primaryEmail(emp) || 'No email'}
                    </div>
                  </div>
                  <div className="list-row__aside" style={{ gap: 8 }}>
                    <select
                      aria-label={`Select PMS fee earner for ${personDisplayName(emp)}`}
                      className="field-select"
                      style={{ width: 260, fontSize: 13 }}
                      value={chosen}
                      onChange={(e) =>
                        setSelectedPmsCodeBy1SqId((prev) => ({
                          ...prev,
                          [emp.id]: e.target.value,
                        }))
                      }
                    >
                      <option value="">Link to PMS fee earner…</option>
                      {unlinkedPmsEmps.map((fe) => (
                        <option key={fe.fee_earner_id} value={fe.fee_earner_id}>
                          {fe.fee_earner_id} — {fe.first_name} {fe.last_name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={pending || !chosen}
                      onClick={() => handleLink('employee', emp.id, chosen)}
                    >
                      Link
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4. MATTERS */}
      {subTab === 'matters' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {pmsAdmin.suggestedMatterMatches.length > 0 && (
            <div className="subcard" style={{ borderLeft: '4px solid var(--accent)' }}>
              <div className="section-label" style={{ marginBottom: 8 }}>
                Suggested matter matches ({pmsAdmin.suggestedMatterMatches.length})
              </div>
              <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                Matters have no shared reference between systems until linked. These candidates
                share the same linked client and work type or description.
              </p>
              {pmsAdmin.suggestedMatterMatches.map((s) => (
                <div
                  key={`${s.onesquaredId}-${s.pmsCode}`}
                  className="list-row"
                  style={{ padding: '10px 0' }}
                >
                  <div className="list-row__main">
                    <div className="list-row__title">
                      <Link href={`/matters/${s.onesquaredId}`}>{s.onesquaredLabel}</Link>{' '}
                      <span className="muted">↔</span> <strong>{s.pmsLabel}</strong>
                    </div>
                    <div className="list-row__meta">{s.reason}</div>
                  </div>
                  <div className="list-row__aside">
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={pending}
                      onClick={() => handleLink('matter', s.onesquaredId, s.pmsCode)}
                    >
                      Confirm link
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              Linked matters ({linksByType.matter.length})
            </div>
            {linksByType.matter.length === 0 ? (
              <p className="muted">No matters linked yet.</p>
            ) : (
              linksByType.matter.map((link) => {
                const m = activeMatters.find((x) => x.id === link.onesquaredId);
                const pm = pmsAdmin.pmsMatters.find((x) => x.matter_code === link.pmsCode);
                return (
                  <div key={link.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        {m ? (
                          <Link href={`/matters/${m.id}`}>
                            {m.matterNumber} — {m.title}
                          </Link>
                        ) : (
                          link.onesquaredId
                        )}{' '}
                        <span className="muted">↔</span>{' '}
                        <strong>
                          {link.pmsCode} — {pm?.matter_description ?? 'PMS matter'}
                        </strong>
                      </div>
                      <div className="list-row__meta">
                        PMS client: {pm?.client_code} · Billing basis: {pm?.billing_basis} ·
                        Status: {pm?.status} ·{' '}
                        {MATCHED_BY_LABELS[link.matchedBy] ?? link.matchedBy}
                      </div>
                    </div>
                    <div className="list-row__aside">
                      <StatusPill
                        label={MATCHED_BY_LABELS[link.matchedBy] ?? link.matchedBy}
                        tone={link.matchedBy === 'manual' ? 'warning' : 'positive'}
                      />
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={pending}
                        onClick={() => handleUnlink(link.id, link.pmsCode)}
                      >
                        Unlink
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              1Squared matters not linked to PMS ({unlinked1SqMatters.length})
            </div>
            {unlinked1SqMatters.length === 0 ? (
              <p className="muted">All 1Squared matters are linked to PMS.</p>
            ) : (
              unlinked1SqMatters.map((m) => {
                const chosen = selectedPmsCodeBy1SqId[m.id] ?? '';
                return (
                  <div key={m.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        <Link href={`/matters/${m.id}`}>
                          {m.matterNumber} — {m.title}
                        </Link>
                      </div>
                      <div className="list-row__meta">Opened {formatDate(m.openedAt)}</div>
                    </div>
                    <div className="list-row__aside" style={{ gap: 8 }}>
                      <select
                        aria-label={`Select PMS matter for ${m.matterNumber}`}
                        className="field-select"
                        style={{ width: 320, fontSize: 13 }}
                        value={chosen}
                        onChange={(e) =>
                          setSelectedPmsCodeBy1SqId((prev) => ({
                            ...prev,
                            [m.id]: e.target.value,
                          }))
                        }
                      >
                        <option value="">Link to PMS matter…</option>
                        {unlinkedPmsMatters.map((pm) => (
                          <option key={pm.matter_code} value={pm.matter_code}>
                            {pm.matter_code} — {pm.matter_description} ({pm.client_code})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={pending || !chosen}
                        onClick={() => handleLink('matter', m.id, chosen)}
                      >
                        Link
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              PMS matters not in 1Squared ({unlinkedPmsMatters.length})
            </div>
            {unlinkedPmsMatters.length === 0 ? (
              <p className="muted">All 20 PMS matters are linked to 1Squared matters.</p>
            ) : (
              unlinkedPmsMatters.map((pm) => (
                <div key={pm.matter_code} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      <strong>
                        {pm.matter_code} — {pm.matter_description}
                      </strong>{' '}
                      <StatusPill
                        label={pm.status}
                        tone={
                          pm.status === 'Open'
                            ? 'positive'
                            : pm.status === 'Pending'
                              ? 'warning'
                              : 'neutral'
                        }
                      />
                    </div>
                    <div className="list-row__meta">
                      Client: {pm.client_code} · {pm.practice_area} ({pm.work_type}) ·{' '}
                      {pm.billing_basis} · Partner: {pm.responsible_partner_id} · Lead:{' '}
                      {pm.fee_earner_id}
                    </div>
                  </div>
                  <div className="list-row__aside">
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={pending}
                      onClick={() =>
                        handleCreateFromPms('matter', pm.matter_code, pm.matter_code)
                      }
                    >
                      + Create matter in 1Squared
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
