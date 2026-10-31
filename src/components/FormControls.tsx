'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  resolveAddressSuggestion,
  searchAddressSuggestions,
  type AddressSuggestion,
} from '@/domain/addressLookup';
import {
  formatEmployeeSelectorOptionLabel,
  isLeaverPerson,
  isSelectableInEmployeeDropdown,
} from '@/domain/employment';
import { optionsFor, valuesForList } from '@/domain/lists';
import { personDisplayName } from '@/domain/names';
import type {
  Address,
  ChoiceList,
  ChoiceValue,
  CustomFieldDefinition,
  Person,
} from '@/domain/types';

export function ChoiceSelect({
  id,
  listKey,
  values,
  value,
  onChange,
  placeholder = 'Select…',
  required,
}: {
  id?: string;
  listKey: string;
  values: ChoiceValue[];
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const opts = useMemo(
    () => optionsFor(values, listKey, value ?? null),
    [values, listKey, value],
  );
  const selected = useMemo(
    () => values.find((v) => v.id === value),
    [values, value],
  );

  return (
    <div>
      <select
        id={id}
        className="field-select"
        value={value ?? ''}
        required={required}
        onChange={(e) => onChange(e.target.value ? e.target.value : null)}
      >
        <option value="">{placeholder}</option>
        {opts.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
            {!o.active ? ' (inactive)' : ''}
          </option>
        ))}
      </select>
      {selected?.description ? (
        <div className="field-help">{selected.description}</div>
      ) : null}
    </div>
  );
}

export function ChoiceMultiGroup({
  listKey,
  values,
  selectedIds,
  onChange,
}: {
  listKey: string;
  values: ChoiceValue[];
  selectedIds: string[];
  onChange: (next: string[]) => void;
}) {
  const opts = useMemo(
    () => optionsFor(values, listKey, selectedIds),
    [values, listKey, selectedIds],
  );

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div className="checkbox-grid">
      {opts.map((o) => {
        const checked = selectedIds.includes(o.id);
        return (
          <label
            key={o.id}
            className="checkbox-pill"
            title={o.description || o.guidance || undefined}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(o.id)}
            />
            <span>
              {o.label}
              {!o.active ? ' (inactive)' : ''}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function EmployeeSelect({
  id,
  employees,
  allPeople,
  values,
  value,
  onChange,
  placeholder = 'Select employee…',
  disabled = false,
}: {
  id?: string;
  employees: Person[];
  allPeople?: Person[];
  values: ChoiceValue[];
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const selectableEmployees = useMemo(
    () => employees.filter((emp) => isSelectableInEmployeeDropdown(emp)),
    [employees],
  );

  const selectedPerson = useMemo(() => {
    if (!value) return null;
    return (
      selectableEmployees.find((e) => e.id === value) ??
      employees.find((e) => e.id === value) ??
      allPeople?.find((p) => p.id === value) ??
      null
    );
  }, [value, selectableEmployees, employees, allPeople]);

  const isSelectedLeaver = Boolean(
    value &&
      (isLeaverPerson(selectedPerson) ||
        (selectedPerson && !selectableEmployees.some((e) => e.id === selectedPerson.id))),
  );

  return (
    <div>
      <select
        id={id}
        className="field-select"
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value ? e.target.value : null)}
      >
        <option value="">{placeholder}</option>
        {isSelectedLeaver && selectedPerson ? (
          <option value={selectedPerson.id}>
            {personDisplayName(selectedPerson)} (Left)
          </option>
        ) : null}
        {selectableEmployees.map((emp) => (
          <option key={emp.id} value={emp.id}>
            {formatEmployeeSelectorOptionLabel(emp, values)}
          </option>
        ))}
      </select>
      {isSelectedLeaver && selectedPerson ? (
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            color: '#b45309',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>
            {personDisplayName(selectedPerson)} has left the firm — please reassign to an active colleague.
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function emptyAddress(defaultCountryId: string | null = null): Address {
  return {
    id: `addr-${Math.random().toString(36).slice(2, 9)}`,
    typeId: null,
    line1: '',
    line2: '',
    town: '',
    county: '',
    postcode: '',
    countryId: defaultCountryId,
  };
}

export function SingleAddressEditor({
  label,
  address,
  onChange,
  values,
  bare = false,
  showTypeSelect = false,
  hintText = 'lookup by postcode or address, or enter manually',
  inputId,
  fieldLabelStyle = false,
}: {
  label: string;
  address: Address | null;
  onChange: (next: Address | null) => void;
  values: ChoiceValue[];
  bare?: boolean;
  showTypeSelect?: boolean;
  hintText?: string;
  inputId?: string;
  fieldLabelStyle?: boolean;
}) {
  const countries = useMemo(() => valuesForList(values, 'country'), [values]);
  const defaultCountry = useMemo(
    () =>
      countries.find((v) => v.label === 'Wales' || v.label === 'United Kingdom')?.id ??
      null,
    [countries],
  );
  const a = address ?? emptyAddress(defaultCountry);

  const formatAddressLine = (addr: {
    line1?: string;
    line2?: string;
    town?: string;
    county?: string;
    postcode?: string;
  }) =>
    [addr.line1, addr.line2, addr.town, addr.county, addr.postcode]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(', ');

  const [lookupQuery, setLookupQuery] = useState<string>(() => formatAddressLine(a));
  const [userTyping, setUserTyping] = useState(false);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const externalFormatted = formatAddressLine(a);
  useEffect(() => {
    if (!userTyping) {
      setLookupQuery(externalFormatted);
    }
  }, [externalFormatted, userTyping]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!userTyping) return;
    const q = lookupQuery.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setDropdownOpen(false);
      setLookupError(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      setLookupError(null);
      const { suggestions: nextSuggestions, error } = await searchAddressSuggestions(
        q,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setSearching(false);
        setSuggestions(nextSuggestions);
        setLookupError(error ?? null);
        setDropdownOpen(true);
      }
    }, 260);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [lookupQuery, userTyping]);

  const update = (patch: Partial<Address>) => {
    const merged = { ...a, ...patch };
    const hasAny =
      merged.line1.trim() ||
      merged.line2.trim() ||
      merged.town.trim() ||
      merged.county.trim() ||
      merged.postcode.trim() ||
      Boolean(merged.typeId);
    onChange(hasAny ? merged : null);
  };

  const handleSelectSuggestion = async (item: AddressSuggestion) => {
    setResolvingId(item.id);
    setLookupError(null);
    const { address: resolved, error } = await resolveAddressSuggestion(item.id);
    setResolvingId(null);

    if (!resolved || error) {
      setLookupError(error ?? 'Could not resolve address details.');
      return;
    }

    const matchedCountry =
      countries.find(
        (c) => c.label.toLowerCase() === resolved.country.toLowerCase(),
      ) ??
      countries.find(
        (c) =>
          c.label === 'United Kingdom' ||
          c.label === 'Wales' ||
          c.label === 'England',
      );

    const nextAddr: Address = {
      ...a,
      line1: resolved.line1,
      line2: resolved.line2,
      town: resolved.town,
      county: resolved.county,
      postcode: resolved.postcode,
      countryId: matchedCountry ? matchedCountry.id : a.countryId,
    };

    const formatted = formatAddressLine(nextAddr);
    setUserTyping(false);
    setLookupQuery(formatted);
    setDropdownOpen(false);
    onChange(nextAddr);
  };

  const handleFindClick = async () => {
    const q = (lookupQuery || a.postcode).trim();
    if (q.length < 3) {
      setLookupError('Type a postcode or part of an address (at least 3 characters).');
      setDropdownOpen(true);
      return;
    }
    setSearching(true);
    setLookupError(null);
    const { suggestions: nextSuggestions, error } = await searchAddressSuggestions(q);
    setSearching(false);
    setSuggestions(nextSuggestions);
    setLookupError(error ?? null);
    setDropdownOpen(true);
  };

  const hasPopulatedDetails = [a.line1, a.line2, a.town, a.county].some(
    (s) => s.trim().length > 0,
  );

  const innerContent = (
    <>
      {showTypeSelect ? (
        <div className="field-group" style={{ marginBottom: 10 }}>
          <label className="field-label">Address type</label>
          <ChoiceSelect
            listKey="address_type"
            values={values}
            value={a.typeId}
            onChange={(typeId) => update({ typeId })}
          />
        </div>
      ) : null}

      <div className="field-group" style={{ marginBottom: 0 }}>
        <div
          className="new-enquiry-subhead"
          style={{
            paddingTop: 0,
            marginTop: 0,
            justifyContent: 'space-between',
            flexWrap: 'nowrap',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <label
              className={fieldLabelStyle ? 'field-label' : 'new-enquiry-card__label'}
              htmlFor={inputId}
              style={fieldLabelStyle ? { marginBottom: 0 } : { textTransform: 'uppercase' }}
            >
              {label}
            </label>
            {([a.line1, a.town, a.postcode].some((s) => s.trim().length > 0)
              ? externalFormatted
              : hintText) ? (
              <span
                className="muted"
                style={{
                  fontSize: 12.5,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {[a.line1, a.town, a.postcode].some((s) => s.trim().length > 0)
                  ? externalFormatted
                  : hintText}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ height: 22, padding: '0 6px', fontSize: 12, flexShrink: 0 }}
            onClick={() => setModalOpen(true)}
          >
            {hasPopulatedDetails ? 'Edit address' : 'Enter manually'}
          </button>
        </div>

        <div ref={wrapRef} style={{ position: 'relative' }}>
          <div className="new-enquiry-postcode-row">
            <input
              id={inputId}
              type="text"
              className="field-input"
              placeholder="Type postcode or street address (e.g. CF10 1AA or 25 St Mary Street)…"
              value={lookupQuery}
              autoComplete="off"
              onFocus={() => {
                if (suggestions.length > 0) {
                  setDropdownOpen(true);
                }
              }}
              onChange={(e) => {
                const val = e.target.value;
                setUserTyping(true);
                setLookupQuery(val);
                if (!val.trim()) {
                  update({
                    line1: '',
                    line2: '',
                    town: '',
                    county: '',
                    postcode: '',
                  });
                } else if (!a.line1.trim()) {
                  update({ postcode: val });
                }
              }}
            />
            <button
              type="button"
              className="btn btn--secondary"
              style={{ borderRadius: 999, padding: '0 16px' }}
              disabled={searching}
              onClick={handleFindClick}
            >
              {searching ? 'Searching…' : 'Find address'}
            </button>
          </div>

          {dropdownOpen ? (
            <div
              role="listbox"
              aria-label="Address suggestions"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                right: 0,
                zIndex: 50,
                background: 'var(--surface, #fff)',
                border: '1px solid var(--border, #e2e8f0)',
                borderRadius: 10,
                boxShadow: '0 10px 25px -5px rgba(15, 23, 42, 0.14)',
                maxHeight: 260,
                overflowY: 'auto',
                padding: 4,
              }}
            >
              {lookupError ? (
                <div
                  style={{
                    padding: '8px 12px',
                    fontSize: 12.5,
                    color: 'var(--coral, #dc2626)',
                  }}
                >
                  {lookupError}
                </div>
              ) : suggestions.length === 0 ? (
                <div className="muted" style={{ padding: '8px 12px', fontSize: 12.5 }}>
                  {searching
                    ? 'Searching Ideal Postcodes…'
                    : 'No matching UK addresses found.'}
                </div>
              ) : (
                suggestions.map((item) => {
                  const isResolving = resolvingId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={false}
                      disabled={Boolean(resolvingId)}
                      onClick={() => handleSelectSuggestion(item)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        border: 'none',
                        background: 'transparent',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 13,
                        color: 'var(--ink, #0f172a)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background =
                          'var(--surface-subtle, #f1f5f9)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span>{item.suggestion}</span>
                      {isResolving ? (
                        <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>
                          Loading…
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          ) : null}
        </div>
      </div>

      {modalOpen ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="modal"
            style={{ maxWidth: 520 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__header">
              <h3 className="modal__title">{label}</h3>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <div
              className="modal__body"
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <div className="field-group">
                <label className="field-label">Address line 1</label>
                <input
                  type="text"
                  className="field-input"
                  value={a.line1}
                  onChange={(e) => update({ line1: e.target.value })}
                />
              </div>
              <div className="field-group">
                <label className="field-label">Address line 2</label>
                <input
                  type="text"
                  className="field-input"
                  value={a.line2}
                  onChange={(e) => update({ line2: e.target.value })}
                />
              </div>
              <div className="new-enquiry-row-2">
                <div className="field-group">
                  <label className="field-label">Town / city</label>
                  <input
                    type="text"
                    className="field-input"
                    value={a.town}
                    onChange={(e) => update({ town: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label">County / region</label>
                  <input
                    type="text"
                    className="field-input"
                    value={a.county}
                    onChange={(e) => update({ county: e.target.value })}
                  />
                </div>
              </div>
              <div className="new-enquiry-row-2">
                <div className="field-group">
                  <label className="field-label">Postcode</label>
                  <input
                    type="text"
                    className="field-input"
                    value={a.postcode}
                    onChange={(e) => update({ postcode: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label">Country</label>
                  <ChoiceSelect
                    listKey="country"
                    values={values}
                    value={a.countryId}
                    onChange={(countryId) => update({ countryId })}
                  />
                </div>
              </div>
            </div>
            <div className="modal__footer">
              {[a.line1, a.line2, a.town, a.county, a.postcode].some(
                (s) => s.trim().length > 0,
              ) ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  style={{ marginRight: 'auto' }}
                  onClick={() => {
                    setUserTyping(false);
                    setLookupQuery('');
                    setSuggestions([]);
                    setDropdownOpen(false);
                    update({
                      line1: '',
                      line2: '',
                      town: '',
                      county: '',
                      postcode: '',
                    });
                  }}
                >
                  Clear address
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setUserTyping(false);
                  setLookupQuery(formatAddressLine(a));
                  setModalOpen(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  if (bare) {
    return innerContent;
  }

  return <div className="subcard">{innerContent}</div>;
}

export function CustomFieldGroupItems({
  definitions,
  values,
  fieldValues,
  errors,
  onChange,
}: {
  definitions: CustomFieldDefinition[];
  values: ChoiceValue[];
  fieldValues: Record<string, unknown>;
  errors?: Record<string, string>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const activeDefs = useMemo(
    () =>
      definitions
        .filter((d) => d.active)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [definitions],
  );

  if (activeDefs.length === 0) return null;

  const setVal = (id: string, val: unknown) => {
    onChange({ ...fieldValues, [id]: val });
  };

  return (
    <>
      {activeDefs.map((def) => {
        const raw = fieldValues[def.id];
        const err = errors?.[def.id];
        return (
          <div
            key={def.id}
            className={`field-group ${def.fieldType === 'longText' ? 'field-group--full' : ''}`}
          >
            <label className="field-label" htmlFor={`cf-${def.id}`}>
              {def.label}{' '}
              {def.required ? <span style={{ color: 'var(--coral)' }}>*</span> : null}
            </label>
            {def.fieldType === 'text' && (
              <input
                id={`cf-${def.id}`}
                type="text"
                className="field-input"
                required={def.required}
                value={typeof raw === 'string' ? raw : ''}
                onChange={(e) => setVal(def.id, e.target.value)}
              />
            )}
            {def.fieldType === 'longText' && (
              <textarea
                id={`cf-${def.id}`}
                className="field-textarea"
                rows={3}
                required={def.required}
                value={typeof raw === 'string' ? raw : ''}
                onChange={(e) => setVal(def.id, e.target.value)}
              />
            )}
            {def.fieldType === 'number' && (
              <input
                id={`cf-${def.id}`}
                type="number"
                className="field-input"
                required={def.required}
                value={raw === null || raw === undefined ? '' : String(raw)}
                onChange={(e) =>
                  setVal(def.id, e.target.value === '' ? null : Number(e.target.value))
                }
              />
            )}
            {def.fieldType === 'date' && (
              <input
                id={`cf-${def.id}`}
                type="date"
                className="field-input"
                required={def.required}
                value={typeof raw === 'string' ? raw : ''}
                onChange={(e) => setVal(def.id, e.target.value || null)}
              />
            )}
            {def.fieldType === 'yesNo' && (
              <select
                id={`cf-${def.id}`}
                className="field-select"
                required={def.required}
                value={
                  raw === true || raw === 'true'
                    ? 'true'
                    : raw === false || raw === 'false'
                      ? 'false'
                      : ''
                }
                onChange={(e) =>
                  setVal(
                    def.id,
                    e.target.value === '' ? null : e.target.value === 'true',
                  )
                }
              >
                <option value="">Select…</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            )}
            {def.fieldType === 'choice' && def.optionsListKey && (
              <ChoiceSelect
                id={`cf-${def.id}`}
                listKey={def.optionsListKey}
                values={values}
                value={typeof raw === 'string' ? raw : null}
                onChange={(v) => setVal(def.id, v)}
                required={def.required}
              />
            )}
            {err ? <span className="field-error">{err}</span> : null}
          </div>
        );
      })}
    </>
  );
}

export function CustomFieldsFormSection({
  definitions,
  values,
  lists,
  fieldValues,
  errors,
  onChange,
}: {
  definitions: CustomFieldDefinition[];
  values: ChoiceValue[];
  lists?: ChoiceList[];
  fieldValues: Record<string, unknown>;
  errors?: Record<string, string>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const activeDefs = useMemo(
    () =>
      definitions
        .filter((d) => d.active)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [definitions],
  );

  if (activeDefs.length === 0) return null;

  return (
    <section className="form-section">
      <h2 className="section-label">Additional details (custom fields)</h2>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <CustomFieldGroupItems
          definitions={activeDefs}
          values={values}
          fieldValues={fieldValues}
          errors={errors}
          onChange={onChange}
        />
        {lists ? null : null}
      </div>
    </section>
  );
}
