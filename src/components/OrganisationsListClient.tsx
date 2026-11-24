'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { isInactiveStatus } from '@/domain/attention';
import type { PillTone, UrgencyEdgeKind } from '@/domain/badges';
import { isBefore } from '@/domain/dates';
import type { SortDirection } from '@/domain/listNavigationState';
import { optionsFor, resolveLabel, resolveLabels, systemKeyOf } from '@/domain/lists';
import { personDisplayName, primaryEmail } from '@/domain/names';
import type {
  ListPaginationMeta,
  OrganisationsListSortColumn,
  OrganisationsListTabFilter,
} from '@/server/pageLoaders';
import type {
  ChoiceValue,
  Matter,
  Organisation,
  Person,
  PersonOrganisationLink,
} from '@/domain/types';
import {
  DataList,
  DataListFilterBar,
  DataListPagination,
  PersonChip,
  useListDensity,
  useServerListNavigation,
  type ActiveFilterChipItem,
  type DataListColumn,
  type DataListSortState,
} from './DataList';
import { StatusPill } from './SearchBox';

interface Props {
  organisations: Organisation[];
  people?: Person[];
  links?: PersonOrganisationLink[];
  matters?: Matter[];
  activeMatterCountsByOrgId?: Record<string, number>;
  values: ChoiceValue[];
  employees: Person[];
  currentUserId?: string;
  pagination?: ListPaginationMeta;
  initialFilters?: {
    tab: OrganisationsListTabFilter;
    query: string;
    typeFilter: string;
    statusFilter: string;
    orgTypeFilter: string;
    sectorFilter: string;
    ownerFilter: string;
    sortBy?: OrganisationsListSortColumn | null;
    sortDir?: SortDirection | null;
  };
}

type OrganisationsTab = OrganisationsListTabFilter;

const ORGS_PARAM_DEFAULTS = {
  tab: 'all',
  q: '',
  type: 'all',
  status: 'all',
  orgType: 'all',
  sector: 'all',
  owner: 'all',
  sort: '',
  dir: '',
  page: 1,
};

function orgStatusTone(label: string): PillTone {
  const l = label.toLowerCase();
  if (l.includes('active') || l.includes('client') || l.includes('current')) {
    return 'positive';
  }
  if (l.includes('prospect') || l.includes('onboarding') || l.includes('pipeline')) {
    return 'warning';
  }
  return 'neutral';
}

export function OrganisationsListClient({
  organisations,
  people = [],
  links = [],
  matters = [],
  activeMatterCountsByOrgId,
  values,
  employees,
  currentUserId = '',
  pagination,
  initialFilters,
}: Props) {
  const router = useRouter();
  const {
    navigateNow,
    navigateDebounced,
    canSyncServerQuery,
    acknowledgeServerQuery,
  } = useServerListNavigation({
    basePath: '/organisations',
    router,
    defaults: ORGS_PARAM_DEFAULTS,
    initialQuery: initialFilters?.query,
  });

  const [tab, setTab] = useState<OrganisationsTab>(initialFilters?.tab ?? 'all');
  const [searchQuery, setSearchQuery] = useState(initialFilters?.query ?? '');
  const [typeFilter, setTypeFilter] = useState(initialFilters?.typeFilter ?? 'all');
  const [statusFilter, setStatusFilter] = useState(initialFilters?.statusFilter ?? 'all');
  const [orgTypeFilter, setOrgTypeFilter] = useState(initialFilters?.orgTypeFilter ?? 'all');
  const [sectorFilter, setSectorFilter] = useState(initialFilters?.sectorFilter ?? 'all');
  const [ownerFilter, setOwnerFilter] = useState(initialFilters?.ownerFilter ?? 'all');
  const [sort, setSort] = useState<DataListSortState | null>(
    initialFilters?.sortBy
      ? {
          columnId: initialFilters.sortBy,
          direction: initialFilters.sortDir ?? 'asc',
        }
      : null,
  );
  const [density, setDensity] = useListDensity(currentUserId, 'comfortable');

  const initialKey = JSON.stringify(initialFilters ?? null);
  const prevInitialKeyRef = useRef(initialKey);
  useEffect(() => {
    if (prevInitialKeyRef.current === initialKey) return;
    prevInitialKeyRef.current = initialKey;
    if (!initialFilters) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setTab(initialFilters.tab);
      if (canSyncServerQuery(initialFilters.query)) {
        setSearchQuery(initialFilters.query);
        acknowledgeServerQuery(initialFilters.query);
      }
      setTypeFilter(initialFilters.typeFilter);
      setStatusFilter(initialFilters.statusFilter);
      setOrgTypeFilter(initialFilters.orgTypeFilter);
      setSectorFilter(initialFilters.sectorFilter);
      setOwnerFilter(initialFilters.ownerFilter);
      setSort(
        initialFilters.sortBy
          ? {
              columnId: initialFilters.sortBy,
              direction: initialFilters.sortDir ?? 'asc',
            }
          : null,
      );
    });
    return () => {
      active = false;
    };
  }, [acknowledgeServerQuery, canSyncServerQuery, initialKey, initialFilters]);

  const toQueryMap = (overrides?: Partial<{
    tab: OrganisationsTab;
    query: string;
    typeFilter: string;
    statusFilter: string;
    orgTypeFilter: string;
    sectorFilter: string;
    ownerFilter: string;
    sort: DataListSortState | null;
    page: number;
  }>) => {
    const nextSort = overrides && 'sort' in overrides ? overrides.sort : sort;
    return {
      tab: overrides?.tab ?? tab,
      q: overrides?.query ?? searchQuery,
      type: overrides?.typeFilter ?? typeFilter,
      status: overrides?.statusFilter ?? statusFilter,
      orgType: overrides?.orgTypeFilter ?? orgTypeFilter,
      sector: overrides?.sectorFilter ?? sectorFilter,
      owner: overrides?.ownerFilter ?? ownerFilter,
      sort: nextSort?.columnId ?? '',
      dir: nextSort?.direction ?? '',
      page: overrides?.page ?? 1,
    };
  };

  const handleSortChange = (next: DataListSortState | null) => {
    setSort(next);
    if (pagination) navigateNow(toQueryMap({ sort: next, page: 1 }), 'replace');
  };

  const handleTabChange = (next: OrganisationsTab) => {
    setTab(next);
    if (pagination) navigateNow(toQueryMap({ tab: next, page: 1 }), 'replace');
  };
  const handleSearchChange = (next: string) => {
    setSearchQuery(next);
    if (pagination) navigateDebounced(toQueryMap({ query: next, page: 1 }));
  };
  const handleFilter = (
    key: 'typeFilter' | 'statusFilter' | 'orgTypeFilter' | 'sectorFilter' | 'ownerFilter',
    val: string,
  ) => {
    if (key === 'typeFilter') setTypeFilter(val);
    if (key === 'statusFilter') setStatusFilter(val);
    if (key === 'orgTypeFilter') setOrgTypeFilter(val);
    if (key === 'sectorFilter') setSectorFilter(val);
    if (key === 'ownerFilter') setOwnerFilter(val);
    if (pagination) navigateNow(toQueryMap({ [key]: val, page: 1 }), 'replace');
  };
  const handleClearAll = () => {
    setTypeFilter('all');
    setStatusFilter('all');
    setOrgTypeFilter('all');
    setSectorFilter('all');
    setOwnerFilter('all');
    setSearchQuery('');
    if (pagination) {
      navigateNow(
        toQueryMap({
          typeFilter: 'all',
          statusFilter: 'all',
          orgTypeFilter: 'all',
          sectorFilter: 'all',
          ownerFilter: 'all',
          query: '',
          page: 1,
        }),
        'replace',
      );
    }
  };
  const handlePageChange = (nextPage: number) => {
    navigateNow(toQueryMap({ page: nextPage }), 'push');
  };

  const empById = useMemo(
    () => new Map(employees.map((e) => [e.id, personDisplayName(e)])),
    [employees],
  );
  const personById = useMemo(
    () => new Map(people.map((p) => [p.id, p])),
    [people],
  );

  const relTypeOptions = useMemo(
    () => optionsFor(values, 'organisation_relationship_type'),
    [values],
  );
  const statusOptions = useMemo(
    () => optionsFor(values, 'relationship_status'),
    [values],
  );
  const orgTypeOptions = useMemo(
    () => optionsFor(values, 'organisation_type'),
    [values],
  );
  const sectorOptions = useMemo(() => optionsFor(values, 'sector'), [values]);

  const primaryContactForOrg = useMemo(() => {
    const map = new Map<
      string,
      { person: Person; jobTitle: string } | undefined
    >();
    for (const o of organisations) {
      const orgLinks = links.filter((l) => l.organisationId === o.id && l.isCurrent);
      const chosen =
        orgLinks.find((l) => l.isPrimaryContact) ??
        orgLinks[0] ??
        links.find((l) => l.organisationId === o.id);
      if (chosen) {
        const p = personById.get(chosen.personId);
        if (p) {
          map.set(o.id, {
            person: p,
            jobTitle: chosen.jobTitle || chosen.roleWithinOrganisation || p.jobTitle,
          });
        }
      }
    }
    return map;
  }, [organisations, links, personById]);

  const activeMatterCountByOrg = useMemo(() => {
    const map = new Map<string, number>();
    if (activeMatterCountsByOrgId) {
      for (const [orgId, cnt] of Object.entries(activeMatterCountsByOrgId)) {
        map.set(orgId, cnt);
      }
      return map;
    }
    for (const m of matters) {
      const statusKey = systemKeyOf(values, m.matterStatusId);
      if (statusKey === 'closed' || statusKey === 'archived') continue;
      if (m.clientId.startsWith('O-')) {
        map.set(m.clientId, (map.get(m.clientId) ?? 0) + 1);
      }
    }
    return map;
  }, [activeMatterCountsByOrgId, matters, values]);

  const isClientOrg = (o: Organisation): boolean => {
    const relKeys = o.relationshipTypeIds.map((id) => systemKeyOf(values, id));
    const statusKey = systemKeyOf(values, o.relationshipStatusId);
    return (
      relKeys.some((k) => k === 'client' || k === 'former_client') ||
      statusKey === 'active'
    );
  };

  const isProspectOrg = (o: Organisation): boolean => {
    const relKeys = o.relationshipTypeIds.map((id) => systemKeyOf(values, id));
    const statusKey = systemKeyOf(values, o.relationshipStatusId);
    return relKeys.some((k) => k === 'prospect') || statusKey === 'prospective';
  };

  const activeOrganisations = useMemo(
    () =>
      organisations.filter(
        (o) => !o.mergedIntoId && !isInactiveStatus(values, o.recordStatusId),
      ),
    [organisations, values],
  );

  const archivedOrganisations = useMemo(
    () =>
      organisations.filter(
        (o) => !o.mergedIntoId && isInactiveStatus(values, o.recordStatusId),
      ),
    [organisations, values],
  );

  const allActiveCount = activeOrganisations.length;
  const clientsCount = useMemo(
    () => activeOrganisations.filter(isClientOrg).length,
    [activeOrganisations, values],
  );
  const prospectsCount = useMemo(
    () => activeOrganisations.filter(isProspectOrg).length,
    [activeOrganisations, values],
  );
  const referrersCount = useMemo(
    () =>
      activeOrganisations.filter((o) => !isClientOrg(o) && !isProspectOrg(o)).length,
    [activeOrganisations, values],
  );
  const archivedCount = archivedOrganisations.length;

  const today = useMemo(() => new Date(), []);

  const filtered = useMemo(() => {
    if (pagination) return organisations;

    const q = searchQuery.trim().toLowerCase();

    const source =
      tab === 'archived'
        ? archivedOrganisations
        : tab === 'clients'
          ? activeOrganisations.filter(isClientOrg)
          : tab === 'prospects'
            ? activeOrganisations.filter(isProspectOrg)
            : tab === 'referrers'
              ? activeOrganisations.filter((o) => !isClientOrg(o) && !isProspectOrg(o))
              : activeOrganisations;

    const list = source.filter((o) => {
      if (typeFilter !== 'all' && !o.relationshipTypeIds.includes(typeFilter)) {
        return false;
      }
      if (statusFilter !== 'all' && o.relationshipStatusId !== statusFilter) {
        return false;
      }
      if (orgTypeFilter !== 'all' && o.organisationTypeId !== orgTypeFilter) {
        return false;
      }
      if (sectorFilter !== 'all' && o.sectorId !== sectorFilter) {
        return false;
      }
      if (ownerFilter !== 'all' && o.relationshipPartnerId !== ownerFilter) {
        return false;
      }
      if (q) {
        const otherNames = o.otherNames.map((n) => n.name).join(' ');
        const town =
          o.registeredAddress?.town || o.correspondenceAddress?.town || '';
        const postcode =
          o.registeredAddress?.postcode || o.correspondenceAddress?.postcode || '';
        const sector = resolveLabel(values, o.sectorId);
        const primaryContact = primaryContactForOrg.get(o.id);
        const contactName = primaryContact
          ? personDisplayName(primaryContact.person)
          : '';
        const hay =
          `${o.id} ${o.legalName} ${otherNames} ${o.companyNumber} ${o.generalEmail} ${o.mainPhone} ${town} ${postcode} ${sector} ${contactName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const defaultSorted = [...list].sort((a, b) =>
      a.legalName.localeCompare(b.legalName),
    );

    if (!sort) return defaultSorted;

    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...defaultSorted].sort((a, b) => {
      if (sort.columnId === 'organisation') {
        const cmp = a.legalName.localeCompare(b.legalName);
        if (cmp !== 0) return cmp * dir;
      } else if (sort.columnId === 'status') {
        const sA = resolveLabel(values, a.relationshipStatusId) || '';
        const sB = resolveLabel(values, b.relationshipStatusId) || '';
        const cmp = sA.localeCompare(sB);
        if (cmp !== 0) return cmp * dir;
      }
      return a.legalName.localeCompare(b.legalName);
    });
  }, [
    pagination,
    organisations,
    tab,
    activeOrganisations,
    archivedOrganisations,
    typeFilter,
    statusFilter,
    orgTypeFilter,
    sectorFilter,
    ownerFilter,
    searchQuery,
    values,
    primaryContactForOrg,
    sort,
  ]);

  const getRowUrgency = (o: Organisation): UrgencyEdgeKind => {
    const conflict = systemKeyOf(values, o.conflictStatusId) === 'potential_conflict';
    const verExp = systemKeyOf(values, o.verificationStatusId) === 'expired';
    if (conflict || verExp) return 'emergency';

    const dup = systemKeyOf(values, o.duplicateStatusId) === 'possible_match';
    const overdue = Boolean(o.reviewDate && isBefore(o.reviewDate, today));
    if (dup || overdue) return 'urgent';

    return null;
  };

  const columns = useMemo<DataListColumn<Organisation>[]>(() => {
    const orgCol: DataListColumn<Organisation> = {
      id: 'organisation',
      header: 'Organisation',
      width: '25%',
      priority: 1,
      sortable: true,
      renderPrimary: (o) => <Link href={`/organisations/${o.id}`}>{o.legalName}</Link>,
      renderSecondary: (o) => {
        const trading = o.otherNames[0]?.name;
        const relLabel = resolveLabels(values, o.relationshipTypeIds)[0];
        return [o.id, trading || relLabel].filter(Boolean).join(' · ');
      },
      tooltip: (o) => {
        const trading = o.otherNames[0]?.name;
        return trading
          ? `${o.legalName} — t/a ${trading} (${o.id})`
          : `${o.legalName} (${o.id})`;
      },
    };

    const contactCol: DataListColumn<Organisation> = {
      id: 'primaryContact',
      header: 'Primary contact',
      width: '22%',
      priority: 1,
      renderPrimary: (o) => {
        const primary = primaryContactForOrg.get(o.id);
        if (primary) {
          return (
            <Link href={`/people/${primary.person.id}`}>
              {personDisplayName(primary.person)}
            </Link>
          );
        }
        if (o.generalEmail) return o.generalEmail;
        if (o.mainPhone) return o.mainPhone;
        return <span className="muted">—</span>;
      },
      renderSecondary: (o) => {
        const primary = primaryContactForOrg.get(o.id);
        if (primary) {
          return (
            primary.jobTitle ||
            primaryEmail(primary.person) ||
            primary.person.phones[0]?.number ||
            undefined
          );
        }
        return o.generalEmail && o.mainPhone ? o.mainPhone : undefined;
      },
      tooltip: (o) => {
        const primary = primaryContactForOrg.get(o.id);
        if (primary) {
          const email = primaryEmail(primary.person);
          return [
            personDisplayName(primary.person),
            primary.jobTitle,
            email,
          ]
            .filter(Boolean)
            .join(' · ');
        }
        return [o.generalEmail, o.mainPhone].filter(Boolean).join(' · ') || undefined;
      },
    };

    const statusCol: DataListColumn<Organisation> = {
      id: 'status',
      header: 'Status',
      width: '155px',
      priority: 1,
      sortable: true,
      renderPrimary: (o) => {
        const conflict = systemKeyOf(values, o.conflictStatusId) === 'potential_conflict';
        if (conflict) {
          return <StatusPill label="Potential conflict" tone="alert" />;
        }
        const statusLabel =
          resolveLabel(values, o.relationshipStatusId) ||
          resolveLabels(values, o.relationshipTypeIds)[0] ||
          'Active';
        return <StatusPill label={statusLabel} tone={orgStatusTone(statusLabel)} />;
      },
      renderSecondary: (o) => {
        const verExp = systemKeyOf(values, o.verificationStatusId) === 'expired';
        const dup = systemKeyOf(values, o.duplicateStatusId) === 'possible_match';
        const overdue = Boolean(o.reviewDate && isBefore(o.reviewDate, today));
        if (verExp) return 'Verification expired';
        if (dup) return 'Possible duplicate';
        if (overdue) return 'Review overdue';
        const activeMatters = activeMatterCountByOrg.get(o.id) ?? 0;
        if (activeMatters > 0) {
          return `${activeMatters} active matter${activeMatters === 1 ? '' : 's'}`;
        }
        return undefined;
      },
    };

    const typeAndRegCol: DataListColumn<Organisation> = {
      id: 'typeAndReg',
      header: 'Type & reg.',
      width: '185px',
      priority: 2,
      renderPrimary: (o) =>
        resolveLabel(values, o.organisationTypeId) || <span className="muted">—</span>,
      renderSecondary: (o) => {
        const sector = o.sectorId ? resolveLabel(values, o.sectorId) : '';
        const coNum = o.companyNumber ? `Co. ${o.companyNumber}` : '';
        return [coNum, sector].filter(Boolean).join(' · ') || undefined;
      },
      tooltip: (o) => {
        const orgType = resolveLabel(values, o.organisationTypeId);
        const sector = o.sectorId ? resolveLabel(values, o.sectorId) : '';
        const coNum = o.companyNumber ? `Co. ${o.companyNumber}` : '';
        return [orgType, coNum, sector].filter(Boolean).join(' · ') || undefined;
      },
    };

    const partnerCol: DataListColumn<Organisation> = {
      id: 'partner',
      header: 'Relationship partner',
      width: '155px',
      priority: 2,
      renderPrimary: (o) => {
        const partnerLabel = o.relationshipPartnerId
          ? empById.get(o.relationshipPartnerId) ?? ''
          : '';
        return <PersonChip name={partnerLabel} emptyLabel="Unassigned" />;
      },
      tooltip: (o) =>
        (o.relationshipPartnerId
          ? empById.get(o.relationshipPartnerId)
          : undefined) ?? 'Unassigned',
    };

    const locationCol: DataListColumn<Organisation> = {
      id: 'location',
      header: 'Location',
      width: '130px',
      priority: 3,
      renderPrimary: (o) => {
        const town = o.registeredAddress?.town || o.correspondenceAddress?.town;
        return town || <span className="muted">—</span>;
      },
      renderSecondary: (o) =>
        o.registeredAddress?.postcode ||
        o.correspondenceAddress?.postcode ||
        undefined,
      tooltip: (o) => {
        const addr = o.registeredAddress || o.correspondenceAddress;
        if (!addr) return undefined;
        return [addr.line1, addr.town, addr.postcode].filter(Boolean).join(', ');
      },
    };

    return [orgCol, contactCol, statusCol, typeAndRegCol, partnerCol, locationCol];
  }, [values, primaryContactForOrg, activeMatterCountByOrg, empById, today]);

  return (
    <div className="page-list">
      <div className="page-header">
        <div>
          <h1>Organisations</h1>
        </div>
      </div>

      <div className="tabs-bar">
        <div
          role="tablist"
          aria-label="Organisation directory views"
          style={{ display: 'flex', alignItems: 'center', gap: 24 }}
        >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={`tab-btn ${tab === 'all' ? 'tab-btn--active' : ''}`}
          onClick={() => handleTabChange('all')}
        >
          All active{tab === 'all' && pagination ? ` (${pagination.totalCount})` : !pagination ? ` (${allActiveCount})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'clients'}
          className={`tab-btn ${tab === 'clients' ? 'tab-btn--active' : ''}`}
          onClick={() => handleTabChange('clients')}
        >
          Clients{tab === 'clients' && pagination ? ` (${pagination.totalCount})` : !pagination ? ` (${clientsCount})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'prospects'}
          className={`tab-btn ${tab === 'prospects' ? 'tab-btn--active' : ''}`}
          onClick={() => handleTabChange('prospects')}
        >
          Prospects{tab === 'prospects' && pagination ? ` (${pagination.totalCount})` : !pagination ? ` (${prospectsCount})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'referrers'}
          className={`tab-btn ${tab === 'referrers' ? 'tab-btn--active' : ''}`}
          onClick={() => handleTabChange('referrers')}
        >
          Referrers &amp; others{tab === 'referrers' && pagination ? ` (${pagination.totalCount})` : !pagination ? ` (${referrersCount})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'archived'}
          className={`tab-btn ${tab === 'archived' ? 'tab-btn--active' : ''}`}
          onClick={() => handleTabChange('archived')}
        >
          Archived{tab === 'archived' && pagination ? ` (${pagination.totalCount})` : !pagination ? ` (${archivedCount})` : ''}
        </button>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingBottom: 6,
            flexShrink: 0,
          }}
        >
          <Link href="/organisations/new" className="btn btn--primary">
            + New organisation
          </Link>
        </div>
      </div>

      <DataListFilterBar
        searchValue={searchQuery}
        onSearchChange={handleSearchChange}
        searchPlaceholder="Search legal name, trading name, company number, contact, town…"
        searchAriaLabel="Search organisations"
        primaryFilters={
          <>
            <select
              id="org-filter-relationship-type"
              name="organisationsFilterRelationshipType"
              aria-label="Filter by relationship type"
              className="field-select list-filter-row__select"
              value={typeFilter}
              onChange={(e) => handleFilter('typeFilter', e.target.value)}
            >
              <option value="all">All relationship types</option>
              {relTypeOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <select
              id="org-filter-status"
              name="organisationsFilterStatus"
              aria-label="Filter by relationship status"
              className="field-select list-filter-row__select"
              value={statusFilter}
              onChange={(e) => handleFilter('statusFilter', e.target.value)}
            >
              <option value="all">All statuses</option>
              {statusOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </>
        }
        moreFiltersActiveCount={
          [
            orgTypeFilter !== 'all',
            sectorFilter !== 'all',
            ownerFilter !== 'all',
          ].filter(Boolean).length
        }
        moreFiltersContent={
          <>
            <div className="field">
              <label className="field-label" htmlFor="org-filter-type">
                Organisation type
              </label>
              <select
                id="org-filter-type"
                name="organisationsFilterOrganisationType"
                aria-label="Filter by organisation type"
                className="field-select"
                value={orgTypeFilter}
                onChange={(e) => handleFilter('orgTypeFilter', e.target.value)}
              >
                <option value="all">All organisation types</option>
                {orgTypeOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="org-filter-sector">
                Sector
              </label>
              <select
                id="org-filter-sector"
                name="organisationsFilterSector"
                aria-label="Filter by sector"
                className="field-select"
                value={sectorFilter}
                onChange={(e) => handleFilter('sectorFilter', e.target.value)}
              >
                <option value="all">All sectors</option>
                {sectorOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="org-filter-partner">
                Relationship partner
              </label>
              <select
                id="org-filter-partner"
                name="organisationsFilterRelationshipPartner"
                aria-label="Filter by relationship partner"
                className="field-select"
                value={ownerFilter}
                onChange={(e) => handleFilter('ownerFilter', e.target.value)}
              >
                <option value="all">All relationship partners</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {personDisplayName(e)}
                  </option>
                ))}
              </select>
            </div>
          </>
        }
        activeChips={[
          ...(typeFilter !== 'all'
            ? [
                {
                  key: 'relType',
                  label: 'Relationship type',
                  valueLabel: resolveLabel(values, typeFilter),
                  onRemove: () => handleFilter('typeFilter', 'all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(statusFilter !== 'all'
            ? [
                {
                  key: 'status',
                  label: 'Status',
                  valueLabel: resolveLabel(values, statusFilter),
                  onRemove: () => handleFilter('statusFilter', 'all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(orgTypeFilter !== 'all'
            ? [
                {
                  key: 'orgType',
                  label: 'Organisation type',
                  valueLabel: resolveLabel(values, orgTypeFilter),
                  onRemove: () => handleFilter('orgTypeFilter', 'all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(sectorFilter !== 'all'
            ? [
                {
                  key: 'sector',
                  label: 'Sector',
                  valueLabel: resolveLabel(values, sectorFilter),
                  onRemove: () => handleFilter('sectorFilter', 'all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(ownerFilter !== 'all'
            ? [
                {
                  key: 'partner',
                  label: 'Partner',
                  valueLabel: empById.get(ownerFilter) ?? ownerFilter,
                  onRemove: () => handleFilter('ownerFilter', 'all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
        ]}
        onClearAll={handleClearAll}
        density={density}
        onDensityChange={setDensity}
      />

      <DataList
        columns={columns}
        rows={filtered}
        getRowId={(o) => o.id}
        getRowUrgency={getRowUrgency}
        onRowClick={(o) => router.push(`/organisations/${o.id}`)}
        sort={sort}
        onSortChange={handleSortChange}
        defaultSortLabel="Alphabetical (legal name)"
        density={density}
        emptyMessage="No organisations match the selected view and filters."
        ariaLabel="Organisations directory"
        renderMobileCard={(o) => {
          const statusLabel =
            resolveLabel(values, o.relationshipStatusId) ||
            resolveLabels(values, o.relationshipTypeIds)[0] ||
            'Active';
          const partnerLabel = o.relationshipPartnerId
            ? empById.get(o.relationshipPartnerId) ?? ''
            : '';
          const orgTypeLabel = resolveLabel(values, o.organisationTypeId);
          return (
            <>
              <div className="data-list__card-top">
                <Link href={`/organisations/${o.id}`} style={{ fontWeight: 600 }}>
                  {o.legalName}
                </Link>
                <StatusPill label={statusLabel} tone={orgStatusTone(statusLabel)} />
              </div>
              <div className="data-list__card-summary">
                {[o.id, orgTypeLabel, o.companyNumber ? `Co. ${o.companyNumber}` : '']
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <div className="data-list__card-footer">
                <PersonChip name={partnerLabel} emptyLabel="Unassigned" />
              </div>
            </>
          );
        }}
      />
      {pagination ? (
        <DataListPagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          totalCount={pagination.totalCount}
          onPageChange={handlePageChange}
          itemLabel="organisations"
        />
      ) : null}
    </div>
  );
}
