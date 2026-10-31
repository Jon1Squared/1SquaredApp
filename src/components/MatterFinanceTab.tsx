'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Link2, Unlink } from 'lucide-react';
import { linkPmsRecordAction, unlinkPmsRecordAction } from '@/app/actions';
import { formatDate } from '@/domain/dates';
import { formatGbp, formatPmsAsAtLabel, formatWholePct } from '@/domain/pms';
import type { AppRole } from '@/domain/types';
import type { MatterPmsViewBundle } from '@/server/services';
import { StatusPill } from './SearchBox';
import { useToast } from './Toast';

interface Props {
  matterId: string;
  matterNumber: string;
  pmsView: MatterPmsViewBundle;
  currentUserRole: AppRole;
}

export function MatterFinanceTab({ matterId, matterNumber, pmsView, currentUserRole }: Props) {
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [selectedPmsCode, setSelectedPmsCode] = useState(
    pmsView.unlinkedPmsMattersForClient[0]?.matter_code ??
      pmsView.allUnlinkedPmsMatters[0]?.matter_code ??
      '',
  );

  // Time entry filters
  const [feFilter, setFeFilter] = useState<string>('ALL');
  const [billedFilter, setBilledFilter] = useState<'ALL' | 'UNBILLED' | 'BILLED'>('ALL');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');

  // Expanded bills
  const [expandedInvoices, setExpandedInvoices] = useState<Record<string, boolean>>({});

  const isAdmin = currentUserRole === 'admin';
  const asAtLabel = formatPmsAsAtLabel(pmsView.extractInfo.asAtDate);

  const bundle = pmsView.matterBundle;
  const fin = bundle?.summary ?? null;

  const feeEarnerOptions = useMemo(() => {
    if (!bundle) return [];
    const seen = new Map<string, string>();
    for (const te of bundle.timeEntries) {
      if (!seen.has(te.fee_earner_id)) {
        seen.set(te.fee_earner_id, te.fee_earner_name ?? te.fee_earner_id);
      }
    }
    return Array.from(seen.entries());
  }, [bundle]);

  const filteredTimeEntries = useMemo(() => {
    if (!bundle) return [];
    return bundle.timeEntries.filter((te) => {
      if (feFilter !== 'ALL' && te.fee_earner_id !== feFilter) return false;
      if (billedFilter === 'UNBILLED' && te.billed_status !== 'Unbilled') return false;
      if (billedFilter === 'BILLED' && te.billed_status !== 'Billed') return false;
      if (dateFrom && te.date < dateFrom) return false;
      if (dateTo && te.date > dateTo) return false;
      return true;
    });
  }, [bundle, feFilter, billedFilter, dateFrom, dateTo]);

  const filteredTimeTotals = useMemo(() => {
    let hours = 0;
    let value = 0;
    for (const te of filteredTimeEntries) {
      hours += te.hours;
      value += te.value;
    }
    return {
      hours: Math.round((hours + Number.EPSILON) * 100) / 100,
      value: Math.round((value + Number.EPSILON) * 100) / 100,
    };
  }, [filteredTimeEntries]);

  const totalChargeableHours = useMemo(() => {
    if (!bundle) return 0;
    const sum = bundle.timeEntries
      .filter((t) => t.chargeable === 'Y')
      .reduce((s, t) => s + t.hours, 0);
    return Math.round((sum + Number.EPSILON) * 100) / 100;
  }, [bundle]);

  const unbilledWipHours = useMemo(() => {
    if (!bundle) return 0;
    const sum = bundle.wipBreakdown.byFeeEarner.reduce((s, r) => s + r.hours, 0);
    return Math.round((sum + Number.EPSILON) * 100) / 100;
  }, [bundle]);

  const handleLink = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPmsCode) return;
    startTransition(async () => {
      await linkPmsRecordAction('matter', matterId, selectedPmsCode);
      showToast(`Linked ${matterNumber} to PMS matter ${selectedPmsCode}`);
    });
  };

  const handleUnlink = () => {
    if (!pmsView.link) return;
    startTransition(async () => {
      await unlinkPmsRecordAction(pmsView.link!.id);
      showToast(`Unlinked PMS matter ${pmsView.link!.pmsCode}`);
    });
  };

  const toggleInvoice = (invNo: string) => {
    setExpandedInvoices((prev) => ({ ...prev, [invNo]: !prev[invNo] }));
  };

  // Unlinked state — never show £0.00
  if (!pmsView.link || !bundle || !fin) {
    return (
      <section className="profile-section">
        <div className="profile-section__header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="section-label">PMS Financial Position</span>
            <StatusPill label={`PMS · as at ${asAtLabel}`} tone="neutral" />
          </div>
        </div>

        <div
          className="subcard"
          style={{
            padding: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            alignItems: 'flex-start',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusPill label="Not linked to the PMS" tone="neutral" />
            <span className="muted" style={{ fontSize: 14 }}>
              This 1Squared matter has no PMS link yet. Financial figures are only shown for linked
              PMS matters.
            </span>
          </div>

          {isAdmin ? (
            <form
              onSubmit={handleLink}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 10,
                marginTop: 6,
              }}
            >
              <select
                aria-label="Select PMS matter to link"
                className="field-select"
                style={{ minWidth: 340 }}
                value={selectedPmsCode}
                onChange={(e) => setSelectedPmsCode(e.target.value)}
              >
                <option value="">Choose an unlinked PMS matter…</option>
                {pmsView.unlinkedPmsMattersForClient.length > 0 && (
                  <optgroup label="Same linked client in PMS">
                    {pmsView.unlinkedPmsMattersForClient.map((pm) => (
                      <option key={pm.matter_code} value={pm.matter_code}>
                        {pm.matter_code} — {pm.matter_description} ({pm.billing_basis})
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="All unlinked PMS matters">
                  {pmsView.allUnlinkedPmsMatters.map((pm) => (
                    <option key={pm.matter_code} value={pm.matter_code}>
                      {pm.matter_code} — {pm.matter_description} ({pm.client_code})
                    </option>
                  ))}
                </optgroup>
              </select>
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={pending || !selectedPmsCode}
              >
                <Link2 size={15} />
                <span>Link to PMS matter</span>
              </button>
              <Link href="/admin/pms-links" className="btn btn--ghost btn--sm">
                Manage all PMS links →
              </Link>
            </form>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Ask an administrator to link this matter in <strong>Admin → PMS links</strong>.
            </p>
          )}
        </div>
      </section>
    );
  }

  // Linked state
  const currentEst = fin.fee_estimate > 0 ? fin.fee_estimate : null;
  const pctUsed = fin.estimate_used_pct > 0 ? fin.estimate_used_pct : null;
  const alertPct = fin.estimate_alert_pct > 0 ? fin.estimate_alert_pct : 0.8;
  const isOver100 = pctUsed !== null && pctUsed > 1;
  const isOverAlert = pctUsed !== null && pctUsed >= alertPct;

  const isCappedFee = fin.billing_basis === 'Capped Fee';
  const isRetainer = fin.billing_basis === 'Retainer / Subscription';
  const capExceeded =
    isCappedFee && fin.fixed_fee_amount > 0 && fin.time_value_recorded > fin.fixed_fee_amount;

  // Stacked bar widths against max(currentEst, fees_billed + unbilled_wip)
  const barScaleBase =
    currentEst && currentEst > 0
      ? Math.max(currentEst, fin.fees_billed + fin.unbilled_wip)
      : 0;
  const billedBarPct =
    barScaleBase > 0 ? Math.min(100, (fin.fees_billed / barScaleBase) * 100) : 0;
  const wipBarPct =
    barScaleBase > 0
      ? Math.min(100 - billedBarPct, (fin.unbilled_wip / barScaleBase) * 100)
      : 0;
  const alertLinePosPct =
    barScaleBase > 0 && currentEst
      ? Math.min(100, ((currentEst * alertPct) / barScaleBase) * 100)
      : alertPct * 100;
  const est100LinePosPct =
    barScaleBase > 0 && currentEst ? Math.min(100, (currentEst / barScaleBase) * 100) : 100;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Top source attribution bar */}
      <div
        className="subcard"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          padding: '12px 16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusPill label="PMS" tone="positive" />
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            Linked to PMS matter {fin.matter_code} — {fin.matter_description}
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            · Figures from PMS · as at {asAtLabel}
          </span>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Link href="/admin/pms-links" className="btn btn--ghost btn--sm">
              PMS links
            </Link>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={pending}
              onClick={handleUnlink}
            >
              <Unlink size={14} />
              <span>Unlink</span>
            </button>
          </div>
        )}
      </div>

      {/* 1. Headline figures */}
      <section className="profile-section" style={{ marginBottom: 0 }}>
        <div className="profile-section__header">
          <span className="section-label">
            Headline Figures · PMS · as at {asAtLabel}
          </span>
          <StatusPill label={fin.billing_basis} tone="neutral" />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))',
            gap: 12,
          }}
        >
          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Current fee estimate / fixed fee</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {currentEst !== null
                ? formatGbp(currentEst)
                : fin.fixed_fee_amount > 0
                  ? formatGbp(fin.fixed_fee_amount)
                  : '—'}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {fin.billing_basis}
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Time recorded</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.time_value_recorded)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {totalChargeableHours} chargeable hrs
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Unbilled WIP</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.unbilled_wip)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {unbilledWipHours} hrs unbilled
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Unbilled disbursements</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.unbilled_disbursements)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Office account (ex VAT)
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Fees billed (ex VAT)</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.fees_billed)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Total billed inc VAT: {formatGbp(fin.total_invoiced_inc_vat)}
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Paid to date</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.total_paid)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Office receipts
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
              {fin.max_invoice_days_past_due !== null && fin.max_invoice_days_past_due > 0
                ? `Oldest ${fin.max_invoice_days_past_due}d past due`
                : 'No overdue bills'}
            </div>
          </div>

          <div className="subcard" style={{ padding: 14 }}>
            <div className="kv-label">Client account balance</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
              {formatGbp(fin.client_account_balance)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Held on client ledger
            </div>
          </div>
        </div>
      </section>

      {/* 2. Fee estimate & budget bar */}
      <section className="profile-section" style={{ marginBottom: 0 }}>
        <div className="profile-section__header">
          <span className="section-label">Fee Estimate, Budget &amp; History · PMS</span>
          {pctUsed !== null && (
            <StatusPill
              label={`${formatWholePct(pctUsed)} of estimate`}
              tone={isOver100 ? 'alert' : isOverAlert ? 'warning' : 'positive'}
            />
          )}
        </div>

        {/* Capped fee callout (e.g. SEV001-0001) */}
        {isCappedFee && fin.fixed_fee_amount > 0 && (
          <div
            className={`banner ${capExceeded ? 'banner--alert' : 'banner--warning'}`}
            style={{ marginBottom: 14 }}
          >
            <div>
              <strong>Capped fee matter:</strong> Time recorded at standard rates is{' '}
              <strong>{formatGbp(fin.time_value_recorded)}</strong> against the{' '}
              <strong>{formatGbp(fin.fixed_fee_amount)}</strong> agreed cap
              {capExceeded
                ? ` — ${formatGbp(fin.time_value_recorded - fin.fixed_fee_amount)} over the cap.`
                : '.'}
            </div>
          </div>
        )}

        {/* Annual retainer callout (e.g. HAR001-0003) */}
        {isRetainer && fin.fee_estimate > 0 && (
          <div className="subcard" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div>
                <strong>Retainer / subscription:</strong> Billed so far{' '}
                <strong>{formatGbp(fin.fees_billed)}</strong> against annual retainer value of{' '}
                <strong>{formatGbp(fin.fee_estimate)}</strong> (
                {formatWholePct(fin.fees_billed / fin.fee_estimate)} billed).
              </div>
              <span className="muted" style={{ fontSize: 13 }}>
                Time recorded against retainer: {formatGbp(fin.time_value_recorded)} (
                {totalChargeableHours} hrs)
              </span>
            </div>
          </div>
        )}

        {/* Stacked horizontal bar for Billed + Unbilled WIP against currentEst */}
        {currentEst !== null && currentEst > 0 ? (
          <div className="subcard" style={{ marginBottom: 16 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 8,
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                Fees billed ({formatGbp(fin.fees_billed)}) + Unbilled WIP (
                {formatGbp(fin.unbilled_wip)}) ={' '}
                <strong>{formatGbp(fin.fees_billed + fin.unbilled_wip)}</strong> of{' '}
                <strong>{formatGbp(currentEst)}</strong> estimate ({formatWholePct(pctUsed)})
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                Alert threshold at {formatWholePct(alertPct)} ({formatGbp(currentEst * alertPct)})
              </div>
            </div>

            <div
              style={{
                position: 'relative',
                height: 22,
                background: 'var(--surface-subtle)',
                borderRadius: 6,
                overflow: 'hidden',
                border: '1px solid var(--border)',
              }}
            >
              {/* Billed segment */}
              <div
                title={`Fees billed (ex VAT): ${formatGbp(fin.fees_billed)}`}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${billedBarPct}%`,
                  background: isOver100
                    ? 'var(--danger, #c53030)'
                    : isOverAlert
                      ? 'var(--warning, #d97706)'
                      : 'var(--primary)',
                }}
              />
              {/* Unbilled WIP segment */}
              <div
                title={`Unbilled WIP: ${formatGbp(fin.unbilled_wip)}`}
                style={{
                  position: 'absolute',
                  left: `${billedBarPct}%`,
                  top: 0,
                  bottom: 0,
                  width: `${wipBarPct}%`,
                  background: isOver100
                    ? 'rgba(197, 48, 48, 0.65)'
                    : isOverAlert
                      ? 'rgba(217, 119, 6, 0.65)'
                      : 'rgba(59, 130, 246, 0.55)',
                }}
              />
              {/* Alert threshold line */}
              <div
                title={`Alert threshold (${formatWholePct(alertPct)})`}
                style={{
                  position: 'absolute',
                  left: `${alertLinePosPct}%`,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: '#111827',
                }}
              />
              {/* 100% estimate line when exceeded */}
              {isOver100 && (
                <div
                  title={`100% of estimate (${formatGbp(currentEst)})`}
                  style={{
                    position: 'absolute',
                    left: `${est100LinePosPct}%`,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    background: '#7f1d1d',
                  }}
                />
              )}
            </div>

            <div
              style={{
                display: 'flex',
                gap: 16,
                marginTop: 8,
                fontSize: 12,
                flexWrap: 'wrap',
              }}
            >
              <span>
                ■ <strong>Fees billed (ex VAT):</strong> {formatGbp(fin.fees_billed)}
              </span>
              <span>
                ▨ <strong>Unbilled WIP:</strong> {formatGbp(fin.unbilled_wip)}
              </span>
              <span>
                │ <strong>Alert line ({formatWholePct(alertPct)}):</strong>{' '}
                {formatGbp(currentEst * alertPct)}
              </span>
            </div>
          </div>
        ) : null}

        {/* Estimate history table */}
        <div className="section-label" style={{ marginBottom: 8 }}>
          Estimate history ({bundle.estimates.length})
        </div>
        {bundle.estimates.length === 0 ? (
          <p className="muted">No formal fee estimates recorded in PMS for this matter.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '8px 10px' }}>Ref</th>
                  <th style={{ padding: '8px 10px' }}>Date given</th>
                  <th style={{ padding: '8px 10px' }}>Type</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Fees estimate</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Disb. estimate</th>
                  <th style={{ padding: '8px 10px' }}>Given by</th>
                  <th style={{ padding: '8px 10px' }}>Accepted by client</th>
                  <th style={{ padding: '8px 10px' }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {bundle.estimates.map((est) => {
                  const isPending = est.accepted_by_client === 'Pending';
                  return (
                    <tr
                      key={est.estimate_id}
                      style={{ borderBottom: '1px solid var(--border)' }}
                    >
                      <td style={{ padding: '8px 10px', fontWeight: 600 }}>{est.estimate_id}</td>
                      <td style={{ padding: '8px 10px' }}>{formatDate(est.date_given)}</td>
                      <td style={{ padding: '8px 10px' }}>{est.estimate_type}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                        {formatGbp(est.fees_estimate)}
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                        {formatGbp(est.disbursements_estimate)}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        {est.given_by_name ?? est.given_by}
                      </td>
                      <td style={{ padding: '8px 10px' }}>
                        <StatusPill
                          label={
                            isPending
                              ? 'Pending client acceptance'
                              : est.accepted_by_client
                          }
                          tone={
                            isPending
                              ? 'warning'
                              : est.accepted_by_client === 'Yes'
                                ? 'positive'
                                : 'neutral'
                          }
                        />
                      </td>
                      <td style={{ padding: '8px 10px', fontSize: 13 }}>{est.notes}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. Time & WIP */}
      <section className="profile-section" style={{ marginBottom: 0 }}>
        <div className="profile-section__header">
          <span className="section-label">
            Time Entries &amp; Unbilled WIP · PMS · as at {asAtLabel}
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            {bundle.timeEntries.length} total entries
          </span>
        </div>

        {/* Unbilled WIP breakdown by fee earner & age buckets */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 14,
            marginBottom: 16,
          }}
        >
          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 8 }}>
              Unbilled WIP by fee earner
            </div>
            {bundle.wipBreakdown.byFeeEarner.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No unbilled WIP on this matter.
              </p>
            ) : (
              bundle.wipBreakdown.byFeeEarner.map((row) => (
                <div
                  key={row.fee_earner_id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '6px 0',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 13,
                  }}
                >
                  <span>
                    <strong>{row.name}</strong> ({row.grade}) · {row.hours} hrs
                  </span>
                  <strong>{formatGbp(row.wip_value)}</strong>
                </div>
              ))
            )}
          </div>

          <div className="subcard">
            <div className="section-label" style={{ marginBottom: 8 }}>
              Unbilled WIP by age (as at {asAtLabel})
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 8,
                textAlign: 'center',
              }}
            >
              <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6 }}>
                <div className="muted" style={{ fontSize: 11 }}>
                  0–30 days
                </div>
                <div style={{ fontWeight: 700, marginTop: 4 }}>
                  {formatGbp(bundle.wipBreakdown.byAgeBucket.bucket_0_30)}
                </div>
              </div>
              <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6 }}>
                <div className="muted" style={{ fontSize: 11 }}>
                  31–60 days
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    marginTop: 4,
                    color:
                      bundle.wipBreakdown.byAgeBucket.bucket_31_60 > 0
                        ? 'var(--warning)'
                        : undefined,
                  }}
                >
                  {formatGbp(bundle.wipBreakdown.byAgeBucket.bucket_31_60)}
                </div>
              </div>
              <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6 }}>
                <div className="muted" style={{ fontSize: 11 }}>
                  61–90 days
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    marginTop: 4,
                    color:
                      bundle.wipBreakdown.byAgeBucket.bucket_61_90 > 0
                        ? 'var(--warning)'
                        : undefined,
                  }}
                >
                  {formatGbp(bundle.wipBreakdown.byAgeBucket.bucket_61_90)}
                </div>
              </div>
              <div style={{ padding: 8, background: 'var(--surface)', borderRadius: 6 }}>
                <div className="muted" style={{ fontSize: 11 }}>
                  90+ days
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    marginTop: 4,
                    color:
                      bundle.wipBreakdown.byAgeBucket.bucket_90_plus > 0
                        ? 'var(--danger)'
                        : undefined,
                  }}
                >
                  {formatGbp(bundle.wipBreakdown.byAgeBucket.bucket_90_plus)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div
          className="subcard"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            alignItems: 'flex-end',
            marginBottom: 12,
          }}
        >
          <div>
            <label className="field-label" htmlFor="te-fe-filter">
              Fee earner
            </label>
            <select
              id="te-fe-filter"
              className="field-select"
              style={{ width: 200 }}
              value={feFilter}
              onChange={(e) => setFeFilter(e.target.value)}
            >
              <option value="ALL">All fee earners</option>
              {feeEarnerOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name} ({id})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="field-label" htmlFor="te-billed-filter">
              Billing status
            </label>
            <select
              id="te-billed-filter"
              className="field-select"
              style={{ width: 170 }}
              value={billedFilter}
              onChange={(e) =>
                setBilledFilter(e.target.value as 'ALL' | 'UNBILLED' | 'BILLED')
              }
            >
              <option value="ALL">All entries</option>
              <option value="UNBILLED">Unbilled WIP only</option>
              <option value="BILLED">Billed only</option>
            </select>
          </div>

          <div>
            <label className="field-label" htmlFor="te-date-from">
              From date
            </label>
            <input
              id="te-date-from"
              type="date"
              className="field-input"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>

          <div>
            <label className="field-label" htmlFor="te-date-to">
              To date
            </label>
            <input
              id="te-date-to"
              type="date"
              className="field-input"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>

          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div className="muted" style={{ fontSize: 12 }}>
              Filtered total ({filteredTimeEntries.length} entries)
            </div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {filteredTimeTotals.hours} hrs · {formatGbp(filteredTimeTotals.value)}
            </div>
          </div>
        </div>

        {/* Time entries table */}
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '8px 10px' }}>Date</th>
                <th style={{ padding: '8px 10px' }}>Fee earner</th>
                <th style={{ padding: '8px 10px' }}>Activity</th>
                <th style={{ padding: '8px 10px' }}>Narrative</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Hours</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Rate</th>
                <th style={{ padding: '8px 10px', textAlign: 'right' }}>Value</th>
                <th style={{ padding: '8px 10px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredTimeEntries.map((te) => (
                <tr key={te.time_id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    {formatDate(te.date)}
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    {te.fee_earner_name ?? te.fee_earner_id}
                  </td>
                  <td style={{ padding: '8px 10px', fontSize: 13 }}>{te.activity}</td>
                  <td style={{ padding: '8px 10px', fontSize: 13 }}>{te.narrative}</td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    {te.hours.toFixed(1)}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    {formatGbp(te.rate)}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                    {formatGbp(te.value)}
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    {te.chargeable === 'N' || te.billed_status === 'Non-chargeable' ? (
                      <StatusPill label="Non-chargeable" tone="neutral" />
                    ) : te.billed_status === 'Billed' ? (
                      <StatusPill label={`Billed (${te.invoice_number})`} tone="positive" />
                    ) : te.billed_status === 'Written off' ? (
                      <StatusPill label="Written off" tone="neutral" />
                    ) : (
                      <StatusPill label="Unbilled WIP" tone="warning" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 4. Bills & Payments */}
      <section className="profile-section" style={{ marginBottom: 0 }}>
        <div className="profile-section__header">
          <span className="section-label">
            Bills &amp; Payments ({bundle.invoices.length}) · PMS · as at {asAtLabel}
          </span>
        </div>

        {bundle.invoices.length === 0 ? (
          <p className="muted">No bills issued on this matter yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '8px 10px' }}>Bill #</th>
                  <th style={{ padding: '8px 10px' }}>Date</th>
                  <th style={{ padding: '8px 10px' }}>Due date</th>
                  <th style={{ padding: '8px 10px' }}>Type</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Fees (ex VAT)</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Disb.</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>VAT</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Total (inc VAT)</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Paid</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Credits</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Outstanding</th>
                  <th style={{ padding: '8px 10px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {bundle.invoices.map((inv) => {
                  const isOpen = !!expandedInvoices[inv.invoice_number];
                  const invPayments = inv.payments;
                  const invTime = inv.timeEntries;
                  const invDisb = inv.disbursements;
                  const invCredits = inv.appliedCreditNotes;

                  const statusTone =
                    inv.recalculated_status === 'Paid' || inv.recalculated_status === 'Applied'
                      ? 'positive'
                      : inv.recalculated_status === 'Overdue'
                        ? 'alert'
                        : inv.recalculated_status === 'Part paid'
                          ? 'warning'
                          : 'neutral';

                  return (
                    <React.Fragment key={inv.invoice_number}>
                      <tr
                        onClick={() => toggleInvoice(inv.invoice_number)}
                        style={{
                          borderBottom: '1px solid var(--border)',
                          cursor: 'pointer',
                        }}
                      >
                        <td style={{ padding: '8px 10px', fontWeight: 600 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            {inv.invoice_number}
                          </span>
                        </td>
                        <td style={{ padding: '8px 10px' }}>{formatDate(inv.invoice_date)}</td>
                        <td style={{ padding: '8px 10px' }}>
                          {inv.due_date ? formatDate(inv.due_date) : '—'}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          {inv.invoice_type}
                          {inv.credit_note_for ? (
                            <div className="muted" style={{ fontSize: 11 }}>
                              Against {inv.credit_note_for}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {formatGbp(inv.fees_net)}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {formatGbp(inv.disbursements_net)}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {formatGbp(inv.vat)}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                          {formatGbp(inv.total)}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {formatGbp(inv.paid)}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {inv.credit_notes < 0 ? formatGbp(inv.credit_notes) : '—'}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>
                          {formatGbp(inv.outstanding)}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <StatusPill label={inv.recalculated_status} tone={statusTone} />
                          {inv.days_past_due !== null &&
                          inv.days_past_due > 0 &&
                          inv.outstanding > 0 ? (
                            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                              {inv.days_past_due}d past due ({inv.age_bucket})
                            </div>
                          ) : null}
                        </td>
                      </tr>

                      {isOpen && (
                        <tr style={{ background: 'var(--surface-subtle)' }}>
                          <td colSpan={12} style={{ padding: 14 }}>
                            {inv.period_from || inv.period_to ? (
                              <div style={{ fontSize: 13, marginBottom: 8 }}>
                                <strong>Billing period:</strong>{' '}
                                {inv.period_from ? formatDate(inv.period_from) : '—'} to{' '}
                                {inv.period_to ? formatDate(inv.period_to) : '—'}
                              </div>
                            ) : null}
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                                gap: 12,
                              }}
                            >
                              <div>
                                <div className="section-label" style={{ marginBottom: 4 }}>
                                  Payments received ({invPayments.length})
                                </div>
                                {invPayments.length === 0 ? (
                                  <div className="muted" style={{ fontSize: 12 }}>
                                    No payments recorded against this bill.
                                  </div>
                                ) : (
                                  invPayments.map((p) => (
                                    <div key={p.receipt_id} style={{ fontSize: 12 }}>
                                      {formatDate(p.receipt_date)} ·{' '}
                                      <strong>{formatGbp(p.amount)}</strong> ({p.method} ·{' '}
                                      {p.reference})
                                    </div>
                                  ))
                                )}
                                {invCredits.length > 0 && (
                                  <div style={{ marginTop: 6 }}>
                                    <div className="section-label" style={{ marginBottom: 2 }}>
                                      Credit notes applied
                                    </div>
                                    {invCredits.map((cn) => (
                                      <div key={cn.invoice_number} style={{ fontSize: 12 }}>
                                        {cn.invoice_number} ({formatDate(cn.invoice_date)}) ·{' '}
                                        <strong>{formatGbp(cn.total)}</strong>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>

                              <div>
                                <div className="section-label" style={{ marginBottom: 4 }}>
                                  Time entries covered ({invTime.length}) &amp; Disbursements (
                                  {invDisb.length})
                                </div>
                                {invTime.length === 0 && invDisb.length === 0 ? (
                                  <div className="muted" style={{ fontSize: 12 }}>
                                    Fixed / stage / retainer fee bill (no itemised time linked).
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 12 }}>
                                    {invTime.length > 0 && (
                                      <div>
                                        {invTime.length} time entries (
                                        {invTime
                                          .reduce((s, t) => s + t.hours, 0)
                                          .toFixed(1)}{' '}
                                        hrs ·{' '}
                                        {formatGbp(
                                          invTime.reduce((s, t) => s + t.value, 0),
                                        )}
                                        )
                                      </div>
                                    )}
                                    {invDisb.map((d) => (
                                      <div key={d.disbursement_id}>
                                        Disb {d.disbursement_id}: {d.type} ({d.supplier}) ·{' '}
                                        {formatGbp(d.net_amount)} ex VAT
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 5. Disbursements */}
      <section className="profile-section" style={{ marginBottom: 0 }}>
        <div className="profile-section__header">
          <span className="section-label">
            Disbursements ({bundle.disbursements.length}) · PMS · as at {asAtLabel}
          </span>
        </div>

        {bundle.disbursements.length === 0 ? (
          <p className="muted">No disbursements recorded on this matter.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '8px 10px' }}>Date</th>
                  <th style={{ padding: '8px 10px' }}>Type</th>
                  <th style={{ padding: '8px 10px' }}>Supplier &amp; description</th>
                  <th style={{ padding: '8px 10px' }}>Paid from</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Net</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>VAT</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Gross</th>
                  <th style={{ padding: '8px 10px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {bundle.disbursements.map((d) => (
                  <tr key={d.disbursement_id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px' }}>{formatDate(d.date)}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 600 }}>{d.type}</td>
                    <td style={{ padding: '8px 10px', fontSize: 13 }}>
                      <strong>{d.supplier}</strong> — {d.description}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <StatusPill
                        label={d.paid_from}
                        tone={d.paid_from === 'Client account' ? 'positive' : 'neutral'}
                      />
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                      {formatGbp(d.net_amount)}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                      {formatGbp(d.vat_amount)}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>
                      {formatGbp(d.gross_amount)}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      {d.paid_from === 'Client account' ? (
                        <StatusPill label="Paid from client funds" tone="positive" />
                      ) : d.billed_status === 'Billed' ? (
                        <StatusPill label={`Billed (${d.invoice_number})`} tone="positive" />
                      ) : (
                        <StatusPill label="Unbilled (Office)" tone="warning" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 6. Client account ledger */}
      <section className="profile-section" style={{ marginBottom: 0 }}>
        <div className="profile-section__header">
          <span className="section-label">
            Client Account Ledger ({bundle.clientAccount.length}) · PMS · as at {asAtLabel}
          </span>
          <span style={{ fontWeight: 700, fontSize: 14 }}>
            Closing balance: {formatGbp(fin.client_account_balance)}
          </span>
        </div>

        {bundle.clientAccount.length === 0 ? (
          <p className="muted">No client account transactions on this matter.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '8px 10px' }}>Date</th>
                  <th style={{ padding: '8px 10px' }}>Ref</th>
                  <th style={{ padding: '8px 10px' }}>Type</th>
                  <th style={{ padding: '8px 10px' }}>Description</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Amount</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Running balance</th>
                </tr>
              </thead>
              <tbody>
                {bundle.clientAccount.map((tx) => (
                  <tr key={tx.transaction_id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px' }}>{formatDate(tx.date)}</td>
                    <td style={{ padding: '8px 10px', fontSize: 13 }}>{tx.transaction_id}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <StatusPill
                        label={tx.type}
                        tone={tx.amount > 0 ? 'positive' : 'neutral'}
                      />
                    </td>
                    <td style={{ padding: '8px 10px', fontSize: 13 }}>{tx.description}</td>
                    <td
                      style={{
                        padding: '8px 10px',
                        textAlign: 'right',
                        fontWeight: 600,
                        color: tx.amount < 0 ? 'var(--muted)' : 'var(--positive)',
                      }}
                    >
                      {formatGbp(tx.amount)}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>
                      {formatGbp(tx.running_balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
