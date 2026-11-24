'use client';

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  createRecordFromPmsAction,
  linkPmsRecordAction,
  loadPmsLinksAdminDataAction,
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
  type PmsAdminSnapshot,
  type PmsLinksAdminPageData,
  type PmsLinksSubTab,
} from '@/domain/pms';
import type { Matter, Organisation, Person, PmsEntityType } from '@/domain/types';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  pmsAdmin: PmsAdminSnapshot;
  initialData?: PmsLinksAdminPageData;
  organisations?: Organisation[];
  people?: Person[];
  matters?: Matter[];
  onPmsLinksCountChange?: (nextCount: number) => void;
}

const PMS_LINKS_PAGE_SIZE = 50;

const MATCHED_BY_LABELS: Record<string, string> = {
  auto_company_number: 'Auto (company number)',
  auto_email: 'Auto (email)',
  manual: 'Manual',
  seed: 'Initial demo link',
};

function PmsPaginationControls({
  page,
  pageSize,
  totalCount,
  loading,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  loading: boolean;
  onPageChange: (nextPage: number) => void;
}) {
  if (totalCount === 0) return null;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(totalCount, page * pageSize);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginTop: 12,
        paddingTop: 10,
        borderTop: '1px solid var(--border-subtle)',
        flexWrap: 'wrap',
      }}
    >
      <span className="muted" style={{ fontSize: 12.5 }}>
        Showing {start}–{end} of {totalCount}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={loading || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={loading || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function PmsLinksAdminSection({
  pmsAdmin: initialPmsAdmin,
  initialData,
  organisations = [],
  people = [],
  matters = [],
  onPmsLinksCountChange,
}: Props) {
  const { showToast } = useToast();
  const [subTab, setSubTab] = useState<PmsLinksSubTab>(
    initialData?.subTab ?? 'organisations',
  );
  const [searchInput, setSearchInput] = useState(initialData?.query ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(
    initialData?.query ?? '',
  );
  const [page, setPage] = useState<number>(initialData?.page ?? 1);
  const [refreshTick, setRefreshTick] = useState(0);

  const [pageData, setPageData] = useState<PmsLinksAdminPageData | null>(
    initialData ?? null,
  );
  const [loadingPage, setLoadingPage] = useState<boolean>(!initialData);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [selectedPmsCodeBy1SqId, setSelectedPmsCodeBy1SqId] = useState<
    Record<string, string>
  >({});

  const seqRef = useRef(0);
  const lastFetchedSignatureRef = useRef<string | null>(
    initialData
      ? JSON.stringify({
          subTab: initialData.subTab,
          query: initialData.query,
          page: initialData.page,
          refreshTick: 0,
        })
      : null,
  );

  // Debounce server search query and reset page to 1 when query changes.
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === debouncedQuery) return;
    const t = setTimeout(() => {
      setPage(1);
      setDebouncedQuery(trimmed);
    }, 280);
    return () => clearTimeout(t);
  }, [searchInput, debouncedQuery]);

  // Fetch the active sub-tab's resolved link titles and SQL-paged unlinked rows.
  useEffect(() => {
    const sig = JSON.stringify({
      subTab,
      query: debouncedQuery,
      page,
      refreshTick,
    });
    if (lastFetchedSignatureRef.current === sig) return;

    let cancelled = false;
    const seq = ++seqRef.current;

    const timer = setTimeout(() => {
      if (cancelled) return;
      setLoadingPage(true);
      void loadPmsLinksAdminDataAction({
        subTab,
        query: debouncedQuery,
        page,
        pageSize: PMS_LINKS_PAGE_SIZE,
      })
        .then((res) => {
          if (cancelled || seq !== seqRef.current) return;
          if (isActionDenied(res)) {
            setLoadError(res.message || "Couldn't load PMS link data. Try again.");
          } else {
            lastFetchedSignatureRef.current = sig;
            setPageData(res);
            setLoadError(null);
            onPmsLinksCountChange?.(res.pmsAdmin.pmsLinks.length);
          }
          setLoadingPage(false);
        })
        .catch(() => {
          if (cancelled || seq !== seqRef.current) return;
          setLoadError("Couldn't load PMS link data. Try again.");
          setLoadingPage(false);
        });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [subTab, debouncedQuery, page, refreshTick, onPmsLinksCountChange]);

  const activePmsAdmin = pageData?.pmsAdmin ?? initialPmsAdmin;
  const linkedRecordTitles = useMemo(
    () => pageData?.linkedRecordTitles ?? {},
    [pageData?.linkedRecordTitles],
  );

  const pmsOrgClients = useMemo(
    () => activePmsAdmin.pmsClients.filter((c) => c.client_type === 'Organisation'),
    [activePmsAdmin.pmsClients],
  );
  const pmsIndClients = useMemo(
    () => activePmsAdmin.pmsClients.filter((c) => c.client_type === 'Individual'),
    [activePmsAdmin.pmsClients],
  );

  const linksByType = useMemo(() => {
    const map: Record<PmsEntityType, typeof activePmsAdmin.pmsLinks> = {
      organisation: [],
      person: [],
      employee: [],
      matter: [],
    };
    for (const l of activePmsAdmin.pmsLinks) {
      map[l.entityType].push(l);
    }
    return map;
  }, [activePmsAdmin.pmsLinks]);

  const fallbackOrgById = useMemo(
    () => new Map(organisations.map((o) => [o.id, o])),
    [organisations],
  );
  const fallbackPersonById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people],
  );
  const fallbackMatterById = useMemo(
    () => new Map(matters.map((m) => [m.id, m])),
    [matters],
  );

  const triggerReload = () => {
    lastFetchedSignatureRef.current = null;
    setRefreshTick((t) => t + 1);
  };

  const handleSubTabChange = (nextTab: PmsLinksSubTab) => {
    if (nextTab === subTab) return;
    setSubTab(nextTab);
    setPage(1);
    setLoadError(null);
  };

  const handleLink = (
    entityType: PmsEntityType,
    onesquaredId: string,
    pmsCode: string,
  ) => {
    if (!pmsCode) return;
    startTransition(async () => {
      const res = await linkPmsRecordAction(entityType, onesquaredId, pmsCode);
      if (isActionDenied(res)) {
        showToast(res.message);
        return;
      }
      showToast(`Linked ${pmsCode} in 1Squared`);
      triggerReload();
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
      triggerReload();
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
      triggerReload();
    });
  };

  const handleCreateFromPms = (
    entityType: PmsEntityType,
    pmsCode: string,
    label: string,
  ) => {
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
      triggerReload();
    });
  };

  const linkedOrgPmsCodes = new Set(linksByType.organisation.map((l) => l.pmsCode));
  const unlinkedPmsOrgs = pmsOrgClients.filter(
    (c) => !linkedOrgPmsCodes.has(c.client_code),
  );

  const linkedPersonPmsCodes = new Set(linksByType.person.map((l) => l.pmsCode));
  const unlinkedPmsPeople = pmsIndClients.filter(
    (c) => !linkedPersonPmsCodes.has(c.client_code),
  );

  const linkedEmpPmsCodes = new Set(linksByType.employee.map((l) => l.pmsCode));
  const unlinkedPmsEmps = activePmsAdmin.pmsFeeEarners.filter(
    (fe) => !linkedEmpPmsCodes.has(fe.fee_earner_id),
  );

  const linkedMatterPmsCodes = new Set(linksByType.matter.map((l) => l.pmsCode));
  const unlinkedPmsMatters = activePmsAdmin.pmsMatters.filter(
    (pm) => !linkedMatterPmsCodes.has(pm.matter_code),
  );

  const unlinkedOrgs = pageData?.unlinkedOrganisationsPage.items ?? [];
  const unlinkedOrgsTotal = pageData?.unlinkedOrganisationsPage.totalCount ?? 0;

  const unlinkedPeople = pageData?.unlinkedPeoplePage.items ?? [];
  const unlinkedPeopleTotal = pageData?.unlinkedPeoplePage.totalCount ?? 0;

  const unlinkedEmps = pageData?.unlinkedEmployeesPage.items ?? [];
  const unlinkedEmpsTotal = pageData?.unlinkedEmployeesPage.totalCount ?? 0;

  const unlinkedMatters = pageData?.unlinkedMattersPage.items ?? [];
  const unlinkedMattersTotal = pageData?.unlinkedMattersPage.totalCount ?? 0;

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
                isValidPmsAsAtDate(activePmsAdmin.extractInfo.asAtDate)
                  ? `PMS · as at ${formatPmsAsAtLabel(activePmsAdmin.extractInfo.asAtDate)}`
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
      <div className="tabs-bar" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`tab-btn ${subTab === 'organisations' ? 'tab-btn--active' : ''}`}
          onClick={() => handleSubTabChange('organisations')}
        >
          Organisations ({linksByType.organisation.length} linked · {unlinkedPmsOrgs.length} PMS
          unmatched)
        </button>
        <button
          type="button"
          className={`tab-btn ${subTab === 'people' ? 'tab-btn--active' : ''}`}
          onClick={() => handleSubTabChange('people')}
        >
          Individual clients ({linksByType.person.length} linked · {unlinkedPmsPeople.length} PMS
          unmatched)
        </button>
        <button
          type="button"
          className={`tab-btn ${subTab === 'employees' ? 'tab-btn--active' : ''}`}
          onClick={() => handleSubTabChange('employees')}
        >
          Fee earners ({linksByType.employee.length} linked · {unlinkedPmsEmps.length} PMS
          unmatched)
        </button>
        <button
          type="button"
          className={`tab-btn ${subTab === 'matters' ? 'tab-btn--active' : ''}`}
          onClick={() => handleSubTabChange('matters')}
        >
          Matters ({linksByType.matter.length} linked · {unlinkedPmsMatters.length} PMS unmatched)
        </button>
      </div>

      {/* Server search bar for unlinked 1Squared records */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <input
          type="search"
          className="field-input"
          style={{ maxWidth: 420 }}
          aria-label="Search unlinked 1Squared records"
          placeholder="Search unlinked 1Squared records by name, reference, company no. or email…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        {searchInput ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setSearchInput('');
              setDebouncedQuery('');
              setPage(1);
            }}
          >
            Clear
          </button>
        ) : null}
        {loadingPage ? (
          <span className="muted" style={{ fontSize: 12.5 }}>
            Loading…
          </span>
        ) : null}
      </div>

      {loadError ? (
        <div className="banner banner--warning" role="alert" style={{ marginBottom: 18 }}>
          <div>
            <strong>{loadError}</strong>
          </div>
          <div className="banner__actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={triggerReload}
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}

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
                const resolved = linkedRecordTitles[link.onesquaredId];
                const fallbackOrg = fallbackOrgById.get(link.onesquaredId);
                const pmsClient = pmsOrgClients.find(
                  (c) => c.client_code === link.pmsCode,
                );
                const orgLabel = resolved?.label ?? fallbackOrg?.legalName;
                const companyNumber =
                  resolved?.companyNumber ?? fallbackOrg?.companyNumber;
                return (
                  <div key={link.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        {orgLabel ? (
                          <Link href={resolved?.href ?? `/organisations/${link.onesquaredId}`}>
                            {orgLabel}
                          </Link>
                        ) : (
                          link.onesquaredId
                        )}{' '}
                        <span className="muted">↔</span>{' '}
                        <strong>
                          {link.pmsCode} — {pmsClient?.client_name ?? 'PMS client'}
                        </strong>
                      </div>
                      <div className="list-row__meta">
                        Co. number: {companyNumber || '—'} · PMS Co. number:{' '}
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
              1Squared organisations not linked to PMS ({unlinkedOrgsTotal})
            </div>
            {loadingPage && unlinkedOrgs.length === 0 ? (
              <p className="muted">Loading unlinked organisations…</p>
            ) : unlinkedOrgsTotal === 0 ? (
              <p className="muted">
                {debouncedQuery
                  ? 'No unlinked 1Squared organisations match your search.'
                  : 'All 1Squared organisations are linked.'}
              </p>
            ) : (
              <>
                {unlinkedOrgs.map((org) => {
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
                })}
                <PmsPaginationControls
                  page={page}
                  pageSize={PMS_LINKS_PAGE_SIZE}
                  totalCount={unlinkedOrgsTotal}
                  loading={loadingPage}
                  onPageChange={setPage}
                />
              </>
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
                const resolved = linkedRecordTitles[link.onesquaredId];
                const fallbackPerson = fallbackPersonById.get(link.onesquaredId);
                const pmsClient = pmsIndClients.find(
                  (c) => c.client_code === link.pmsCode,
                );
                const personLabel =
                  resolved?.label ??
                  (fallbackPerson ? personDisplayName(fallbackPerson) : undefined);
                const personEmail =
                  resolved?.primaryEmail ??
                  (fallbackPerson ? primaryEmail(fallbackPerson) : undefined);
                return (
                  <div key={link.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        {personLabel ? (
                          <Link href={resolved?.href ?? `/people/${link.onesquaredId}`}>
                            {personLabel}
                          </Link>
                        ) : (
                          link.onesquaredId
                        )}{' '}
                        <span className="muted">↔</span>{' '}
                        <strong>
                          {link.pmsCode} — {pmsClient?.client_name ?? 'PMS client'}
                        </strong>
                      </div>
                      <div className="list-row__meta">
                        1Squared email: {personEmail || '—'} · PMS email:{' '}
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
              1Squared people not linked to PMS ({unlinkedPeopleTotal})
            </div>
            {loadingPage && unlinkedPeople.length === 0 ? (
              <p className="muted">Loading unlinked people…</p>
            ) : unlinkedPeopleTotal === 0 ? (
              <p className="muted">
                {debouncedQuery
                  ? 'No unlinked 1Squared people match your search.'
                  : 'All 1Squared individual clients are linked.'}
              </p>
            ) : (
              <>
                {unlinkedPeople.map((p) => {
                  const chosen = selectedPmsCodeBy1SqId[p.id] ?? '';
                  return (
                    <div key={p.id} className="list-row">
                      <div className="list-row__main">
                        <div className="list-row__title">
                          <Link href={`/people/${p.id}`}>{p.displayName}</Link>{' '}
                          <span className="muted">({p.id})</span>
                        </div>
                        <div className="list-row__meta">
                          Email: {p.primaryEmail || 'None'}
                        </div>
                      </div>
                      <div className="list-row__aside" style={{ gap: 8 }}>
                        <select
                          aria-label={`Select PMS client for ${p.displayName}`}
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
                <PmsPaginationControls
                  page={page}
                  pageSize={PMS_LINKS_PAGE_SIZE}
                  totalCount={unlinkedPeopleTotal}
                  loading={loadingPage}
                  onPageChange={setPage}
                />
              </>
            )}
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
                      onClick={() =>
                        handleCreateFromPms('person', c.client_code, c.client_name)
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

      {/* 3. EMPLOYEES / FEE EARNERS */}
      {subTab === 'employees' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 10 }}>
              Matched employees &amp; PMS fee earners ({linksByType.employee.length})
            </div>
            {linksByType.employee.map((link) => {
              const resolved = linkedRecordTitles[link.onesquaredId];
              const fallbackEmp = fallbackPersonById.get(link.onesquaredId);
              const fe = activePmsAdmin.pmsFeeEarners.find(
                (f) => f.fee_earner_id === link.pmsCode,
              );
              const feFullName = fe
                ? `${fe.first_name} ${fe.last_name}`
                : 'PMS fee earner';
              const empLabel =
                resolved?.label ??
                (fallbackEmp ? personDisplayName(fallbackEmp) : undefined);
              return (
                <div key={link.id} className="list-row">
                  <div className="list-row__main">
                    <div className="list-row__title">
                      {empLabel ? (
                        <Link href={resolved?.href ?? `/people/${link.onesquaredId}`}>
                          {empLabel}
                        </Link>
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
                      {fe?.department || '—'} · Standard rate: £
                      {fe?.standard_hourly_rate ?? 0}/hr
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
                        {fe.department} · {fe.email} · Standard rate £
                        {fe.standard_hourly_rate}/hr
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
              1Squared employees without a PMS fee earner code ({unlinkedEmpsTotal})
            </div>
            {loadingPage && unlinkedEmps.length === 0 ? (
              <p className="muted">Loading unlinked employees…</p>
            ) : unlinkedEmpsTotal === 0 ? (
              <p className="muted">
                {debouncedQuery
                  ? 'No unlinked employees match your search.'
                  : 'All 1Squared employees have a PMS fee earner code.'}
              </p>
            ) : (
              <>
                {unlinkedEmps.map((emp) => {
                  const chosen = selectedPmsCodeBy1SqId[emp.id] ?? '';
                  return (
                    <div key={emp.id} className="list-row">
                      <div className="list-row__main">
                        <div className="list-row__title">
                          <Link href={`/people/${emp.id}`}>{emp.displayName}</Link>{' '}
                          <span className="muted">({emp.id})</span>
                        </div>
                        <div className="list-row__meta">
                          {emp.jobTitle || 'Employee'} · {emp.primaryEmail || 'No email'}
                        </div>
                      </div>
                      <div className="list-row__aside" style={{ gap: 8 }}>
                        <select
                          aria-label={`Select PMS fee earner for ${emp.displayName}`}
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
                <PmsPaginationControls
                  page={page}
                  pageSize={PMS_LINKS_PAGE_SIZE}
                  totalCount={unlinkedEmpsTotal}
                  loading={loadingPage}
                  onPageChange={setPage}
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* 4. MATTERS */}
      {subTab === 'matters' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {activePmsAdmin.suggestedMatterMatches.length > 0 && (
            <div className="subcard" style={{ borderLeft: '4px solid var(--accent)' }}>
              <div className="section-label" style={{ marginBottom: 8 }}>
                Suggested matter matches ({activePmsAdmin.suggestedMatterMatches.length})
              </div>
              <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                Matters have no shared reference between systems until linked. These candidates
                share the same linked client and work type or description.
              </p>
              {activePmsAdmin.suggestedMatterMatches.map((s) => (
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
                const resolved = linkedRecordTitles[link.onesquaredId];
                const fallbackMatter = fallbackMatterById.get(link.onesquaredId);
                const pm = activePmsAdmin.pmsMatters.find(
                  (x) => x.matter_code === link.pmsCode,
                );
                const matterLabel =
                  resolved?.label ??
                  (fallbackMatter
                    ? `${fallbackMatter.matterNumber} — ${fallbackMatter.title}`
                    : undefined);
                return (
                  <div key={link.id} className="list-row">
                    <div className="list-row__main">
                      <div className="list-row__title">
                        {matterLabel ? (
                          <Link href={resolved?.href ?? `/matters/${link.onesquaredId}`}>
                            {matterLabel}
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
              1Squared matters not linked to PMS ({unlinkedMattersTotal})
            </div>
            {loadingPage && unlinkedMatters.length === 0 ? (
              <p className="muted">Loading unlinked matters…</p>
            ) : unlinkedMattersTotal === 0 ? (
              <p className="muted">
                {debouncedQuery
                  ? 'No unlinked 1Squared matters match your search.'
                  : 'All 1Squared matters are linked to PMS.'}
              </p>
            ) : (
              <>
                {unlinkedMatters.map((m) => {
                  const chosen = selectedPmsCodeBy1SqId[m.id] ?? '';
                  return (
                    <div key={m.id} className="list-row">
                      <div className="list-row__main">
                        <div className="list-row__title">
                          <Link href={`/matters/${m.id}`}>
                            {m.matterNumber} — {m.title}
                          </Link>
                        </div>
                        <div className="list-row__meta">
                          Opened {m.openedAt ? formatDate(m.openedAt) : '—'}
                        </div>
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
                })}
                <PmsPaginationControls
                  page={page}
                  pageSize={PMS_LINKS_PAGE_SIZE}
                  totalCount={unlinkedMattersTotal}
                  loading={loadingPage}
                  onPageChange={setPage}
                />
              </>
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
