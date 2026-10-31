'use client';

import React, { useTransition } from 'react';
import Link from 'next/link';
import { createRecordFromPmsAction } from '@/app/actions';
import { formatDate } from '@/domain/dates';
import { formatGbp, formatPmsAsAtLabel, formatWholePct } from '@/domain/pms';
import type { AppRole } from '@/domain/types';
import type { ClientPmsViewBundle } from '@/server/services';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  recordType: 'organisation' | 'person';
  recordName: string;
  pmsView: ClientPmsViewBundle;
  currentUserRole: AppRole;
}

export function ClientFinanceSection({
  recordType,
  recordName,
  pmsView,
  currentUserRole,
}: Props) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();

  const isAdmin = currentUserRole === 'admin';
  const asAtLabel = formatPmsAsAtLabel(pmsView.extractInfo.asAtDate);

  const bundle = pmsView.clientBundle;
  const fin = bundle?.summary ?? null;
  const pmsClient = pmsView.pmsClient;
  const groupView = pmsView.groupView;

  const handleCreateMatter = (matterCode: string) => {
    startTransition(async () => {
      const res = await createRecordFromPmsAction('matter', matterCode);
      if (!res.ok) {
        showToast(res.error ?? 'Could not create matter in 1Squared');
        return;
      }
      showToast(`Created matter ${matterCode} in 1Squared and linked to PMS`);
    });
  };

  if (!pmsView.link || !bundle || !fin || !pmsClient) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <section className="profile-section" style={{ marginBottom: 0 }}>
          <div className="profile-section__header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="section-label">PMS Client Finance</span>
              <StatusPill label={`PMS · as at ${asAtLabel}`} tone="neutral" />
            </div>
          </div>

          <div
            className="subcard"
            style={{
              padding: 20,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StatusPill label="Not linked to the PMS" tone="neutral" />
              <span className="muted" style={{ fontSize: 14 }}>
                {recordName} is not linked to a PMS client code. Financial figures are never shown
                as zero when a record is unlinked.
              </span>
            </div>
            {isAdmin && (
              <Link href="/admin/pms-links" className="btn btn--secondary btn--sm">
                Link in Admin → PMS links
              </Link>
            )}
          </div>
        </section>

        {/* Even if a parent holding company is not directly linked (though Severn Holdings plc IS linked), render group view if subsidiaries exist */}
        {groupView && <GroupFinanceCard groupView={groupView} asAtLabel={asAtLabel} />}
      </div>
    );
  }

  const totalDebt = fin.outstanding_debt;
  const bNotDue = totalDebt > 0 ? (fin.aged_not_yet_due / totalDebt) * 100 : 0;
  const b1_30 = totalDebt > 0 ? (fin.aged_1_30 / totalDebt) * 100 : 0;
  const b31_60 = totalDebt > 0 ? (fin.aged_31_60 / totalDebt) * 100 : 0;
  const b61_90 = totalDebt > 0 ? (fin.aged_61_90 / totalDebt) * 100 : 0;
  const b90Plus = totalDebt > 0 ? (fin.aged_90_plus / totalDebt) * 100 : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Attribution banner */}
      <div
        className="subcard"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          padding: '12px 16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusPill label="PMS" tone="positive" />
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            Linked to PMS client {pmsClient.client_code} — {pmsClient.client_name}
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            · Payment terms: {pmsClient.credit_terms_days} days · Credit limit:{' '}
            {formatGbp(pmsClient.credit_limit)} · as at {asAtLabel}
          </span>
        </div>
        {isAdmin && (
          <Link href="/admin/pms-links" className="btn btn--ghost btn--sm">
            Manage PMS link
          </Link>
        )}
      </div>

      {/* Group view for parent organisation with subsidiaries (e.g. Severn Holdings plc) */}
      {recordType === 'organisation' && groupView && (
        <GroupFinanceCard groupView={groupView} asAtLabel={asAtLabel} />
      )}

      {/* 1. Client totals */}
      <section className="profile-section" style={{ marginBottom: 0 }}>
        <div className="profile-section__header">
          <span className="section-label">
            Client Financial Totals ({pmsClient.client_code}) · PMS · as at {asAtLabel}
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            {bundle.matters.filter((m) => m.status === 'Open').length} open / {bundle.matters.length}{' '}
            total matters
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))',
            gap: 12,
          }}
        >
          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Unbilled WIP</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.unbilled_wip)}
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Fees billed (ex VAT)</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.fees_billed)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Invoiced (inc VAT): {formatGbp(fin.total_invoiced_inc_vat)}
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Paid to date</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.total_paid)}
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Outstanding debt</div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                marginTop: 4,
                color: fin.outstanding_debt > 0 ? 'var(--warning)' : undefined,
              }}
            >
              {formatGbp(fin.outstanding_debt)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {fin.credit_limit > 0
                ? `${formatWholePct(fin.credit_limit_used_pct)} of ${formatGbp(fin.credit_limit)} credit limit`
                : 'No credit limit'}
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Client account held</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.client_account_balance)}
            </div>
          </div>
        </div>
      </section>

      {/* 2. Aged debt bar */}
      <section className="profile-section" style={{ marginBottom: 0 }}>
        <div className="profile-section__header">
          <span className="section-label">
            Aged Debt Breakdown &amp; Credit Limit · PMS · as at {asAtLabel}
          </span>
          {fin.credit_limit > 0 && fin.credit_limit_used_pct !== null && (
            <StatusPill
              label={`${formatWholePct(fin.credit_limit_used_pct)} of credit limit used`}
              tone={
                fin.credit_limit_used_pct >= 0.8
                  ? 'alert'
                  : fin.credit_limit_used_pct >= 0.5
                    ? 'warning'
                    : 'positive'
              }
            />
          )}
        </div>

        <div className="subcard">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 8,
              fontSize: 14,
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <span>
              Total outstanding debt: <strong>{formatGbp(fin.outstanding_debt)}</strong>
            </span>
            <span className="muted">
              Credit limit: {formatGbp(fin.credit_limit)} (
              {formatWholePct(fin.credit_limit_used_pct)} used)
            </span>
          </div>

          {/* Single stacked horizontal bar */}
          <div
            style={{
              display: 'flex',
              height: 22,
              borderRadius: 6,
              overflow: 'hidden',
              background: 'var(--surface-subtle)',
              border: '1px solid var(--border)',
              marginBottom: 12,
            }}
          >
            {totalDebt <= 0 ? (
              <div
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  color: 'var(--muted)',
                }}
              >
                No outstanding debt
              </div>
            ) : (
              <>
                {bNotDue > 0 && (
                  <div
                    title={`Not yet due: ${formatGbp(fin.aged_not_yet_due)}`}
                    style={{ width: `${bNotDue}%`, background: '#10b981' }}
                  />
                )}
                {b1_30 > 0 && (
                  <div
                    title={`1–30 days: ${formatGbp(fin.aged_1_30)}`}
                    style={{ width: `${b1_30}%`, background: '#3b82f6' }}
                  />
                )}
                {b31_60 > 0 && (
                  <div
                    title={`31–60 days: ${formatGbp(fin.aged_31_60)}`}
                    style={{ width: `${b31_60}%`, background: '#f59e0b' }}
                  />
                )}
                {b61_90 > 0 && (
                  <div
                    title={`61–90 days: ${formatGbp(fin.aged_61_90)}`}
                    style={{ width: `${b61_90}%`, background: '#ea580c' }}
                  />
                )}
                {b90Plus > 0 && (
                  <div
                    title={`90+ days: ${formatGbp(fin.aged_90_plus)}`}
                    style={{ width: `${b90Plus}%`, background: '#dc2626' }}
                  />
                )}
              </>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: 8,
              fontSize: 13,
            }}
          >
            <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                ● Not yet due
              </div>
              <div style={{ fontWeight: 700, marginTop: 2 }}>
                {formatGbp(fin.aged_not_yet_due)}
              </div>
            </div>
            <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                ● 1–30 days overdue
              </div>
              <div style={{ fontWeight: 700, marginTop: 2 }}>{formatGbp(fin.aged_1_30)}</div>
            </div>
            <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                ● 31–60 days overdue
              </div>
              <div style={{ fontWeight: 700, marginTop: 2 }}>{formatGbp(fin.aged_31_60)}</div>
            </div>
            <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                ● 61–90 days overdue
              </div>
              <div
                style={{
                  fontWeight: 700,
                  marginTop: 2,
                  color: fin.aged_61_90 > 0 ? 'var(--warning)' : undefined,
                }}
              >
                {formatGbp(fin.aged_61_90)}
              </div>
            </div>
            <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                ● 90+ days overdue
              </div>
              <div
                style={{
                  fontWeight: 700,
                  marginTop: 2,
                  color: fin.aged_90_plus > 0 ? 'var(--danger, #dc2626)' : undefined,
                }}
              >
                {formatGbp(fin.aged_90_plus)}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Client's matters in PMS */}
      <section className="profile-section" style={{ marginBottom: 0 }}>
        <div className="profile-section__header">
          <span className="section-label">
            Client Matters in PMS ({bundle.matters.length}) · as at {asAtLabel}
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '8px 10px' }}>PMS Matter</th>
                <th style={{ padding: '8px 10px' }}>Status</th>
                <th style={{ padding: '8px 10px' }}>Billing basis</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Estimate / Fixed</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Unbilled WIP</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Billed (ex VAT)</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Outstanding</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Client a/c</th>
                <th style={{ padding: '8px 10px' }}>1Squared record</th>
              </tr>
            </thead>
            <tbody>
              {bundle.matters.map((mf) => {
                const oneSqId = pmsView.oneSquaredMatterIdByPmsCode[mf.matter_code];
                return (
                  <tr
                    key={mf.matter_code}
                    style={{ borderBottom: '1px solid var(--border)' }}
                  >
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ fontWeight: 600 }}>
                        {oneSqId ? (
                          <Link href={`/matters/${oneSqId}`}>
                            {mf.matter_code} — {mf.matter_description}
                          </Link>
                        ) : (
                          `${mf.matter_code} — ${mf.matter_description}`
                        )}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {mf.practice_area} · {mf.work_type} · Opened {formatDate(mf.date_opened)}
                      </div>
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <StatusPill
                        label={mf.status}
                        tone={
                          mf.status === 'Open'
                            ? 'positive'
                            : mf.status === 'Pending'
                              ? 'warning'
                              : 'neutral'
                        }
                      />
                    </td>
                    <td style={{ padding: '8px 10px', fontSize: 13 }}>{mf.billing_basis}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                      {mf.fee_estimate !== null
                        ? formatGbp(mf.fee_estimate)
                        : mf.fixed_fee_amount !== null
                          ? formatGbp(mf.fixed_fee_amount)
                          : '—'}
                      {mf.estimate_used_pct > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {formatWholePct(mf.estimate_used_pct)} used
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                      {formatGbp(mf.unbilled_wip)}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                      {formatGbp(mf.fees_billed)}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        textAlign: 'right',
                        fontWeight: 600,
                        color: mf.outstanding_debt > 0 ? 'var(--warning)' : undefined,
                      }}
                    >
                      {formatGbp(mf.outstanding_debt)}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                      {formatGbp(mf.client_account_balance)}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      {oneSqId ? (
                        <Link
                          href={`/matters/${oneSqId}`}
                          className="btn btn--secondary btn--sm"
                        >
                          Open in 1Squared →
                        </Link>
                      ) : isAdmin ? (
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={pending}
                          onClick={() => handleCreateMatter(mf.matter_code)}
                        >
                          + Create matter in 1Squared
                        </button>
                      ) : (
                        <StatusPill label="PMS only" tone="neutral" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function GroupFinanceCard({
  groupView,
  asAtLabel,
}: {
  groupView: NonNullable<ClientPmsViewBundle['groupView']>;
  asAtLabel: string;
}) {
  const { totals, companies } = groupView;
  return (
    <section
      className="profile-section"
      style={{ marginBottom: 0, borderLeft: '4px solid var(--primary)' }}
    >
      <div className="profile-section__header">
        <div>
          <span className="section-label">
            Corporate Group View — {groupView.parentOrganisationName} &amp; Subsidiaries · PMS ·
            as at {asAtLabel}
          </span>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            Combined PMS figures across {companies.length} group companies and each company&apos;s
            share
          </div>
        </div>
        <StatusPill label="Group rollup (PMS)" tone="positive" />
      </div>

      {/* Group headline cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))',
          gap: 10,
          marginBottom: 14,
        }}
      >
        <div className="subcard" style={{ padding: 12 }}>
          <div className="kv-label">Group unbilled WIP</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
            {formatGbp(totals.unbilled_wip)}
          </div>
        </div>
        <div className="subcard" style={{ padding: 12 }}>
          <div className="kv-label">Group fees billed</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
            {formatGbp(totals.fees_billed)}
          </div>
        </div>
        <div className="subcard" style={{ padding: 12 }}>
          <div className="kv-label">Group paid to date</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
            {formatGbp(totals.total_paid)}
          </div>
        </div>
        <div className="subcard" style={{ padding: 12 }}>
          <div className="kv-label">Group outstanding debt</div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              marginTop: 2,
              color: totals.outstanding_debt > 0 ? 'var(--warning)' : undefined,
            }}
          >
            {formatGbp(totals.outstanding_debt)}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {formatWholePct(totals.credit_limit_used_pct)} of {formatGbp(totals.credit_limit)} group
            credit
          </div>
        </div>
        <div className="subcard" style={{ padding: 12 }}>
          <div className="kv-label">Group client account</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
            {formatGbp(totals.client_account_balance)}
          </div>
        </div>
      </div>

      {/* Per-company breakdown table */}
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
              <th style={{ padding: '8px 10px' }}>Group company</th>
              <th style={{ padding: '8px 10px' }}>PMS code</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Unbilled WIP</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Fees billed</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Paid to date</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Outstanding debt</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Share of group debt</th>
              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Client account</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((co) => {
              const fin = co.financials;
              const debtShare =
                fin && totals.outstanding_debt > 0
                  ? fin.outstanding_debt / totals.outstanding_debt
                  : 0;
              return (
                <tr
                  key={co.organisationId}
                  style={{ borderBottom: '1px solid var(--border)' }}
                >
                  <td style={{ padding: '8px 10px', fontWeight: 600 }}>
                    <Link href={`/organisations/${co.organisationId}`}>
                      {co.organisationName}
                    </Link>{' '}
                    {co.isParent ? (
                      <StatusPill label="Parent" tone="neutral" />
                    ) : (
                      <StatusPill label="Subsidiary" tone="neutral" />
                    )}
                  </td>
                  <td style={{ padding: '8px 10px' }}>{co.pmsClientCode ?? 'Unlinked'}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    {fin ? formatGbp(fin.unbilled_wip) : 'Not linked'}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    {fin ? formatGbp(fin.fees_billed) : 'Not linked'}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    {fin ? formatGbp(fin.total_paid) : 'Not linked'}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                    {fin ? formatGbp(fin.outstanding_debt) : 'Not linked'}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    {fin ? formatWholePct(debtShare) : '—'}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    {fin ? formatGbp(fin.client_account_balance) : 'Not linked'}
                  </td>
                </tr>
              );
            })}
            <tr style={{ fontWeight: 700, background: 'var(--surface-subtle)' }}>
              <td style={{ padding: '8px 10px' }}>Group Total</td>
              <td style={{ padding: '8px 10px' }}>—</td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                {formatGbp(totals.unbilled_wip)}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                {formatGbp(totals.fees_billed)}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                {formatGbp(totals.total_paid)}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                {formatGbp(totals.outstanding_debt)}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                {totals.outstanding_debt > 0 ? '100%' : '—'}
              </td>
              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                {formatGbp(totals.client_account_balance)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
