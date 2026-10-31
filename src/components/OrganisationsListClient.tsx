'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { isInactiveStatus } from '@/domain/attention';
import type { PillTone, UrgencyEdgeKind } from '@/domain/badges';
import { isBefore } from '@/domain/dates';
import { optionsFor, resolveLabel, resolveLabels, systemKeyOf } from '@/domain/lists';
import { personDisplayName, primaryEmail } from '@/domain/names';
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
  PersonChip,
  useListDensity,
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
  values: ChoiceValue[];
  employees: Person[];
  currentUserId?: string;
}

type OrganisationsTab = 'all' | 'clients' | 'prospects' | 'referrers' | 'archived';

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
  values,
  employees,
  currentUserId = '',
}: Props) {
  const router = useRouter();

  const [tab, setTab] = useState<OrganisationsTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [orgTypeFilter, setOrgTypeFilter] = useState('all');
  const [sectorFilter, setSectorFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [sort, setSort] = useState<DataListSortState | null>(null);
  const [density, setDensity] = useListDensity(currentUserId, 'comfortable');

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
    for (const m of matters) {
      const statusLabel = resolveLabel(values, m.matterStatusId).toLowerCase();
      if (statusLabel === 'closed' || statusLabel === 'archived') continue;
      if (m.clientId.startsWith('O-')) {
        map.set(m.clientId, (map.get(m.clientId) ?? 0) + 1);
      }
    }
    return map;
  }, [matters, values]);

  const isClientOrg = (o: Organisation): boolean => {
    const relLabels = resolveLabels(values, o.relationshipTypeIds).map((s) =>
      s.toLowerCase(),
    );
    const statusLabel = resolveLabel(values, o.relationshipStatusId).toLowerCase();
    return (
      relLabels.some((r) => r.includes('client')) ||
      statusLabel.includes('active client')
    );
  };

  const isProspectOrg = (o: Organisation): boolean => {
    const relLabels = resolveLabels(values, o.relationshipTypeIds).map((s) =>
      s.toLowerCase(),
    );
    const statusLabel = resolveLabel(values, o.relationshipStatusId).toLowerCase();
    return (
      relLabels.some((r) => r.includes('prospect')) ||
      statusLabel.includes('prospect')
    );
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
          <p className="muted" style={{ marginTop: 4 }}>
            Corporate clients, prospects, referrers, counterparties and suppliers.
          </p>
        </div>
        <div className="page-header__actions">
          <Link href="/organisations/new" className="btn btn--primary">
            + New organisation
          </Link>
        </div>
      </div>

      <div className="tabs-bar" role="tablist" aria-label="Organisation directory views">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={`tab-btn ${tab === 'all' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('all')}
        >
          All active ({allActiveCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'clients'}
          className={`tab-btn ${tab === 'clients' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('clients')}
        >
          Clients ({clientsCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'prospects'}
          className={`tab-btn ${tab === 'prospects' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('prospects')}
        >
          Prospects ({prospectsCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'referrers'}
          className={`tab-btn ${tab === 'referrers' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('referrers')}
        >
          Referrers &amp; others ({referrersCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'archived'}
          className={`tab-btn ${tab === 'archived' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('archived')}
        >
          Archived ({archivedCount})
        </button>
      </div>

      <DataListFilterBar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Search legal name, trading name, company number, contact, town…"
        searchAriaLabel="Search organisations"
        primaryFilters={
          <>
            <select
              aria-label="Filter by relationship type"
              className="field-select list-filter-row__select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="all">All relationship types</option>
              {relTypeOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by relationship status"
              className="field-select list-filter-row__select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
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
                aria-label="Filter by organisation type"
                className="field-select"
                value={orgTypeFilter}
                onChange={(e) => setOrgTypeFilter(e.target.value)}
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
                aria-label="Filter by sector"
                className="field-select"
                value={sectorFilter}
                onChange={(e) => setSectorFilter(e.target.value)}
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
                aria-label="Filter by relationship partner"
                className="field-select"
                value={ownerFilter}
                onChange={(e) => setOwnerFilter(e.target.value)}
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
                  onRemove: () => setTypeFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(statusFilter !== 'all'
            ? [
                {
                  key: 'status',
                  label: 'Status',
                  valueLabel: resolveLabel(values, statusFilter),
                  onRemove: () => setStatusFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(orgTypeFilter !== 'all'
            ? [
                {
                  key: 'orgType',
                  label: 'Organisation type',
                  valueLabel: resolveLabel(values, orgTypeFilter),
                  onRemove: () => setOrgTypeFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(sectorFilter !== 'all'
            ? [
                {
                  key: 'sector',
                  label: 'Sector',
                  valueLabel: resolveLabel(values, sectorFilter),
                  onRemove: () => setSectorFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(ownerFilter !== 'all'
            ? [
                {
                  key: 'partner',
                  label: 'Partner',
                  valueLabel: empById.get(ownerFilter) ?? ownerFilter,
                  onRemove: () => setOwnerFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
        ]}
        onClearAll={() => {
          setTypeFilter('all');
          setStatusFilter('all');
          setOrgTypeFilter('all');
          setSectorFilter('all');
          setOwnerFilter('all');
          setSearchQuery('');
        }}
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
        onSortChange={setSort}
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
    </div>
  );
}
