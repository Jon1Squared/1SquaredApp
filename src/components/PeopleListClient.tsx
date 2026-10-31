'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { isInactiveStatus } from '@/domain/attention';
import { enquiryStatusTone, type PillTone, type UrgencyEdgeKind } from '@/domain/badges';
import { getEnquiryStagePeople, type EnquiryStagePersonEntry } from '@/domain/enquiries';
import { optionsFor, resolveLabel, resolveLabels, systemKeyOf } from '@/domain/lists';
import { personDisplayName, primaryEmail } from '@/domain/names';
import { mainLinkFor } from '@/domain/searchIndex';
import type {
  ChoiceValue,
  Enquiry,
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
  people: Person[];
  organisations: Organisation[];
  links: PersonOrganisationLink[];
  values: ChoiceValue[];
  employees: Person[];
  enquiries?: Enquiry[];
  currentUserId?: string;
}

type PeopleTab = 'all' | 'external' | 'enquiry' | 'employee' | 'archived';

type PeopleListRow =
  | {
      kind: 'person';
      id: string;
      person: Person;
      surname: string;
      firstName: string;
      displayName: string;
      href: string;
    }
  | {
      kind: 'enquiry_person';
      id: string;
      entry: EnquiryStagePersonEntry;
      surname: string;
      firstName: string;
      displayName: string;
      href: string;
    };

function relationshipStatusTone(label: string): PillTone {
  const l = label.toLowerCase();
  if (l.includes('active') || l.includes('client') || l.includes('current')) {
    return 'positive';
  }
  if (l.includes('prospect') || l.includes('enquiry') || l.includes('onboarding')) {
    return 'warning';
  }
  return 'neutral';
}

export function PeopleListClient({
  people,
  organisations,
  links,
  values,
  employees,
  enquiries = [],
  currentUserId = '',
}: Props) {
  const router = useRouter();

  const [tab, setTab] = useState<PeopleTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [sort, setSort] = useState<DataListSortState | null>(null);
  const [density, setDensity] = useListDensity(currentUserId, 'comfortable');

  const orgById = useMemo(
    () => new Map(organisations.map((o) => [o.id, o])),
    [organisations],
  );
  const empById = useMemo(
    () => new Map(employees.map((e) => [e.id, personDisplayName(e)])),
    [employees],
  );

  const roleOptions = useMemo(() => optionsFor(values, 'person_role'), [values]);
  const statusOptions = useMemo(
    () => optionsFor(values, 'relationship_status'),
    [values],
  );

  const enquiryStagePeople = useMemo(
    () => getEnquiryStagePeople(enquiries, people, values),
    [enquiries, people, values],
  );

  const activePeople = useMemo(
    () =>
      people.filter((p) => !p.mergedIntoId && !isInactiveStatus(values, p.recordStatusId)),
    [people, values],
  );

  const archivedPeople = useMemo(
    () =>
      people.filter((p) => !p.mergedIntoId && isInactiveStatus(values, p.recordStatusId)),
    [people, values],
  );

  const allActiveCount = activePeople.length + enquiryStagePeople.length;
  const externalCount = activePeople.filter((p) => !p.isEmployee).length;
  const enquiryCount = enquiryStagePeople.length;
  const employeeCount = activePeople.filter((p) => p.isEmployee).length;
  const archivedCount = archivedPeople.length;

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    const includePersonRows =
      tab !== 'enquiry' && statusFilter !== 'enquiry_stage';
    const includeEnquiryRows =
      (tab === 'all' || tab === 'external' || tab === 'enquiry') &&
      (statusFilter === 'all' || statusFilter === 'enquiry_stage');

    const sourcePeople =
      tab === 'archived'
        ? archivedPeople
        : tab === 'external'
          ? activePeople.filter((p) => !p.isEmployee)
          : tab === 'employee'
            ? activePeople.filter((p) => p.isEmployee)
            : activePeople;

    const personRows: PeopleListRow[] = !includePersonRows
      ? []
      : sourcePeople
          .filter((p) => {
            if (roleFilter !== 'all' && !p.relationshipRoleIds.includes(roleFilter)) {
              return false;
            }
            if (statusFilter !== 'all' && p.relationshipStatusId !== statusFilter) {
              return false;
            }
            if (ownerFilter !== 'all' && p.relationshipOwnerId !== ownerFilter) {
              return false;
            }
            if (q) {
              const mainLink = mainLinkFor(p.id, links);
              const mainOrg = mainLink
                ? orgById.get(mainLink.organisationId)?.legalName ?? ''
                : p.isEmployee
                  ? 'Not A Law Firm LLP'
                  : '';
              const email = primaryEmail(p) ?? '';
              const phone = p.phones[0]?.number ?? '';
              const town = p.addresses[0]?.town ?? '';
              const hay =
                `${p.id} ${personDisplayName(p)} ${p.preferredName} ${p.jobTitle} ${mainOrg} ${email} ${phone} ${town}`.toLowerCase();
              if (!hay.includes(q)) return false;
            }
            return true;
          })
          .map((p) => ({
            kind: 'person' as const,
            id: p.id,
            person: p,
            surname: p.surname,
            firstName: p.firstName,
            displayName: personDisplayName(p),
            href: `/people/${p.id}`,
          }));

    const enquiryRows: PeopleListRow[] = !includeEnquiryRows
      ? []
      : enquiryStagePeople
          .filter((entry) => {
            if (roleFilter !== 'all' && !entry.relationshipRoleIds.includes(roleFilter)) {
              return false;
            }
            if (ownerFilter !== 'all' && entry.relationshipOwnerId !== ownerFilter) {
              return false;
            }
            if (q) {
              const linkedOrg = entry.linkedOrganisationId
                ? orgById.get(entry.linkedOrganisationId)?.legalName ?? ''
                : entry.callingOnBehalfOf ?? '';
              const hay =
                `${entry.enquiryReference} ${entry.displayName} ${entry.email} ${entry.phone} ${linkedOrg}`.toLowerCase();
              if (!hay.includes(q)) return false;
            }
            return true;
          })
          .map((entry) => ({
            kind: 'enquiry_person' as const,
            id: `enq-person-${entry.id}`,
            entry,
            surname: entry.surname,
            firstName: entry.firstName,
            displayName: entry.displayName,
            href: `/enquiries/${entry.enquiryId}`,
          }));

    const combined = [...personRows, ...enquiryRows].sort(
      (a, b) =>
        a.surname.localeCompare(b.surname) || a.firstName.localeCompare(b.firstName),
    );

    if (!sort) return combined;

    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...combined].sort((a, b) => {
      if (sort.columnId === 'person') {
        const cmp =
          a.surname.localeCompare(b.surname) || a.firstName.localeCompare(b.firstName);
        if (cmp !== 0) return cmp * dir;
      } else if (sort.columnId === 'status') {
        const sA =
          a.kind === 'enquiry_person'
            ? `Enquiry · ${a.entry.enquiryStatus}`
            : resolveLabel(values, a.person.relationshipStatusId) || '';
        const sB =
          b.kind === 'enquiry_person'
            ? `Enquiry · ${b.entry.enquiryStatus}`
            : resolveLabel(values, b.person.relationshipStatusId) || '';
        const cmp = sA.localeCompare(sB);
        if (cmp !== 0) return cmp * dir;
      }
      return a.surname.localeCompare(b.surname) || a.firstName.localeCompare(b.firstName);
    });
  }, [
    tab,
    activePeople,
    archivedPeople,
    enquiryStagePeople,
    roleFilter,
    statusFilter,
    ownerFilter,
    searchQuery,
    links,
    orgById,
    values,
    sort,
  ]);

  const getRowUrgency = (row: PeopleListRow): UrgencyEdgeKind => {
    if (row.kind === 'enquiry_person') return null;
    const p = row.person;
    if (systemKeyOf(values, p.verificationStatusId) === 'expired') return 'emergency';
    if (
      systemKeyOf(values, p.duplicateStatusId) === 'possible_match' ||
      systemKeyOf(values, p.verificationStatusId) === 'in_progress'
    ) {
      return 'urgent';
    }
    return null;
  };

  const columns = useMemo<DataListColumn<PeopleListRow>[]>(() => {
    const personCol: DataListColumn<PeopleListRow> = {
      id: 'person',
      header: 'Person',
      width: '23%',
      priority: 1,
      sortable: true,
      renderPrimary: (row) => <Link href={row.href}>{row.displayName}</Link>,
      renderSecondary: (row) => {
        if (row.kind === 'enquiry_person') {
          const roles = resolveLabels(values, row.entry.relationshipRoleIds);
          return [row.entry.enquiryReference, roles[0] || 'Enquiry caller']
            .filter(Boolean)
            .join(' · ');
        }
        const p = row.person;
        const roleText = p.isEmployee
          ? resolveLabel(values, p.employeeRoleId) || 'Employee'
          : resolveLabels(values, p.relationshipRoleIds)[0] || '';
        return [p.id, roleText].filter(Boolean).join(' · ');
      },
      tooltip: (row) => {
        if (row.kind === 'enquiry_person') {
          return `${row.displayName} (${row.entry.enquiryReference})`;
        }
        return `${row.displayName} (${row.person.id})`;
      },
    };

    const orgCol: DataListColumn<PeopleListRow> = {
      id: 'organisation',
      header: 'Organisation & role',
      width: '23%',
      priority: 1,
      renderPrimary: (row) => {
        if (row.kind === 'enquiry_person') {
          const linkedOrg = row.entry.linkedOrganisationId
            ? orgById.get(row.entry.linkedOrganisationId)
            : undefined;
          if (linkedOrg) {
            return (
              <Link href={`/organisations/${linkedOrg.id}`}>{linkedOrg.legalName}</Link>
            );
          }
          if (row.entry.callingOnBehalfOf) return row.entry.callingOnBehalfOf;
          return <span className="muted">—</span>;
        }
        const p = row.person;
        if (p.isEmployee) return 'Not A Law Firm LLP';
        const mainLink = mainLinkFor(p.id, links);
        const mainOrg = mainLink ? orgById.get(mainLink.organisationId) : undefined;
        if (mainOrg) {
          return <Link href={`/organisations/${mainOrg.id}`}>{mainOrg.legalName}</Link>;
        }
        return <span className="muted">—</span>;
      },
      renderSecondary: (row) => {
        if (row.kind === 'enquiry_person') return 'Enquiry stage';
        const p = row.person;
        const mainLink = mainLinkFor(p.id, links);
        return mainLink?.jobTitle || p.jobTitle || undefined;
      },
      tooltip: (row) => {
        if (row.kind === 'enquiry_person') {
          const linkedOrg = row.entry.linkedOrganisationId
            ? orgById.get(row.entry.linkedOrganisationId)?.legalName
            : row.entry.callingOnBehalfOf;
          return linkedOrg || undefined;
        }
        const p = row.person;
        const mainLink = mainLinkFor(p.id, links);
        const mainOrg = p.isEmployee
          ? 'Not A Law Firm LLP'
          : mainLink
            ? orgById.get(mainLink.organisationId)?.legalName
            : '';
        const job = mainLink?.jobTitle || p.jobTitle;
        return [mainOrg, job].filter(Boolean).join(' · ') || undefined;
      },
    };

    const statusCol: DataListColumn<PeopleListRow> = {
      id: 'status',
      header: 'Status',
      width: '155px',
      priority: 1,
      sortable: true,
      renderPrimary: (row) => {
        if (row.kind === 'enquiry_person') {
          return (
            <StatusPill
              label={`Enquiry · ${row.entry.enquiryStatus}`}
              tone={enquiryStatusTone(row.entry.enquiryStatus)}
            />
          );
        }
        const p = row.person;
        const recSys = systemKeyOf(values, p.recordStatusId);
        if (recSys === 'deceased' || recSys === 'archived') {
          return <StatusPill label={resolveLabel(values, p.recordStatusId)} tone="neutral" />;
        }
        const relLabel =
          resolveLabel(values, p.relationshipStatusId) ||
          (p.isEmployee ? 'Firm staff' : 'Contact');
        return <StatusPill label={relLabel} tone={relationshipStatusTone(relLabel)} />;
      },
      renderSecondary: (row) => {
        if (row.kind === 'enquiry_person') return undefined;
        const p = row.person;
        const verSys = systemKeyOf(values, p.verificationStatusId);
        const dup = systemKeyOf(values, p.duplicateStatusId) === 'possible_match';
        if (verSys === 'expired') return 'Verification expired';
        if (verSys === 'in_progress') return 'ID check in progress';
        if (dup) return 'Possible duplicate';
        if (verSys === 'verified') return 'ID verified';
        return undefined;
      },
    };

    const contactCol: DataListColumn<PeopleListRow> = {
      id: 'contact',
      header: 'Primary contact',
      width: '21%',
      priority: 2,
      renderPrimary: (row) => {
        const email =
          row.kind === 'enquiry_person' ? row.entry.email : primaryEmail(row.person);
        return email || <span className="muted">—</span>;
      },
      renderSecondary: (row) => {
        const phone =
          row.kind === 'enquiry_person'
            ? row.entry.phone
            : row.person.phones[0]?.number;
        return phone || undefined;
      },
      tooltip: (row) => {
        const email =
          row.kind === 'enquiry_person' ? row.entry.email : primaryEmail(row.person);
        const phone =
          row.kind === 'enquiry_person'
            ? row.entry.phone
            : row.person.phones[0]?.number;
        return [email, phone].filter(Boolean).join(' · ') || undefined;
      },
    };

    const ownerCol: DataListColumn<PeopleListRow> = {
      id: 'owner',
      header: 'Relationship owner',
      width: '155px',
      priority: 2,
      renderPrimary: (row) => {
        const ownerId =
          row.kind === 'enquiry_person'
            ? row.entry.relationshipOwnerId
            : row.person.relationshipOwnerId;
        const ownerLabel = ownerId ? empById.get(ownerId) ?? '' : '';
        return <PersonChip name={ownerLabel} emptyLabel="Unassigned" />;
      },
      tooltip: (row) => {
        const ownerId =
          row.kind === 'enquiry_person'
            ? row.entry.relationshipOwnerId
            : row.person.relationshipOwnerId;
        return (ownerId ? empById.get(ownerId) : undefined) ?? 'Unassigned';
      },
    };

    const locationCol: DataListColumn<PeopleListRow> = {
      id: 'location',
      header: 'Location',
      width: '130px',
      priority: 3,
      renderPrimary: (row) => {
        if (row.kind === 'enquiry_person') return <span className="muted">—</span>;
        const town = row.person.addresses[0]?.town;
        return town || <span className="muted">—</span>;
      },
      renderSecondary: (row) => {
        if (row.kind === 'enquiry_person') return undefined;
        return row.person.addresses[0]?.postcode || undefined;
      },
      tooltip: (row) => {
        if (row.kind === 'enquiry_person') return undefined;
        const addr = row.person.addresses[0];
        if (!addr) return undefined;
        return [addr.line1, addr.town, addr.postcode].filter(Boolean).join(', ');
      },
    };

    return [personCol, orgCol, statusCol, contactCol, ownerCol, locationCol];
  }, [values, orgById, links, empById]);

  return (
    <div className="page-list">
      <div className="page-header">
        <div>
          <h1>People</h1>
        </div>
      </div>

      <div className="tabs-bar" role="tablist" aria-label="People directory views">
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
          aria-selected={tab === 'external'}
          className={`tab-btn ${tab === 'external' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('external')}
        >
          External ({externalCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'enquiry'}
          className={`tab-btn ${tab === 'enquiry' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('enquiry')}
        >
          Enquiry stage ({enquiryCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'employee'}
          className={`tab-btn ${tab === 'employee' ? 'tab-btn--active' : ''}`}
          onClick={() => setTab('employee')}
        >
          Firm staff ({employeeCount})
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
          <Link href="/people/new" className="btn btn--primary">
            + New person
          </Link>
        </div>
      </div>

      <DataListFilterBar
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder="Search name, email, phone, organisation, reference…"
        searchAriaLabel="Search people"
        primaryFilters={
          <>
            <select
              aria-label="Filter by relationship role"
              className="field-select list-filter-row__select"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="all">All relationship roles</option>
              {roleOptions.map((r) => (
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
              <option value="enquiry_stage">Enquiry stage</option>
              {statusOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </>
        }
        moreFiltersActiveCount={[ownerFilter !== 'all'].filter(Boolean).length}
        moreFiltersContent={
          <div className="field">
            <label className="field-label" htmlFor="people-filter-owner">
              Relationship owner
            </label>
            <select
              id="people-filter-owner"
              aria-label="Filter by relationship owner"
              className="field-select"
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
            >
              <option value="all">All relationship owners</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {personDisplayName(e)}
                </option>
              ))}
            </select>
          </div>
        }
        activeChips={[
          ...(roleFilter !== 'all'
            ? [
                {
                  key: 'role',
                  label: 'Role',
                  valueLabel: resolveLabel(values, roleFilter),
                  onRemove: () => setRoleFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(statusFilter !== 'all'
            ? [
                {
                  key: 'status',
                  label: 'Status',
                  valueLabel:
                    statusFilter === 'enquiry_stage'
                      ? 'Enquiry stage'
                      : resolveLabel(values, statusFilter),
                  onRemove: () => setStatusFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
          ...(ownerFilter !== 'all'
            ? [
                {
                  key: 'owner',
                  label: 'Owner',
                  valueLabel: empById.get(ownerFilter) ?? ownerFilter,
                  onRemove: () => setOwnerFilter('all'),
                } satisfies ActiveFilterChipItem,
              ]
            : []),
        ]}
        onClearAll={() => {
          setRoleFilter('all');
          setStatusFilter('all');
          setOwnerFilter('all');
          setSearchQuery('');
        }}
        density={density}
        onDensityChange={setDensity}
      />

      <DataList
        columns={columns}
        rows={filtered}
        getRowId={(row) => row.id}
        getRowUrgency={getRowUrgency}
        onRowClick={(row) => router.push(row.href)}
        sort={sort}
        onSortChange={setSort}
        defaultSortLabel="Alphabetical (surname)"
        density={density}
        emptyMessage="No people match the selected view and filters."
        ariaLabel="People directory"
        renderMobileCard={(row) => {
          const ownerId =
            row.kind === 'enquiry_person'
              ? row.entry.relationshipOwnerId
              : row.person.relationshipOwnerId;
          const ownerLabel = ownerId ? empById.get(ownerId) ?? '' : '';
          const email =
            row.kind === 'enquiry_person' ? row.entry.email : primaryEmail(row.person);
          const statusNode =
            row.kind === 'enquiry_person' ? (
              <StatusPill
                label={`Enquiry · ${row.entry.enquiryStatus}`}
                tone={enquiryStatusTone(row.entry.enquiryStatus)}
              />
            ) : (
              <StatusPill
                label={
                  resolveLabel(values, row.person.relationshipStatusId) ||
                  (row.person.isEmployee ? 'Firm staff' : 'Contact')
                }
                tone={relationshipStatusTone(
                  resolveLabel(values, row.person.relationshipStatusId) || '',
                )}
              />
            );
          return (
            <>
              <div className="data-list__card-top">
                <Link href={row.href} style={{ fontWeight: 600 }}>
                  {row.displayName}
                </Link>
                {statusNode}
              </div>
              <div className="data-list__card-summary">{email || '—'}</div>
              <div className="data-list__card-footer">
                <PersonChip name={ownerLabel} emptyLabel="Unassigned" />
              </div>
            </>
          );
        }}
      />
    </div>
  );
}
