'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { previewIntakeDuplicatesAndConflictsAction } from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import type {
  IntakePreviewInput,
  IntakePreviewResult,
} from '@/domain/intakePreviewTypes';

export const INTAKE_FAST_PREVIEW_DEBOUNCE_MS = 280;
export const INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS = 650;
export const INTAKE_CONFLICT_MIN_NAME_CHARS = 3;

export const EMPTY_INTAKE_PREVIEW_RESULT: IntakePreviewResult = {
  duplicatePeople: [],
  duplicateOrganisations: [],
  entityMatches: { people: [], organisations: [] },
  activeLinkedEnquiries: [],
  possibleConflicts: [],
  conflictSearch: null,
};

export interface UseIntakePreviewResult {
  readonly preview: IntakePreviewResult;
  readonly loadingFast: boolean;
  readonly loadingConflicts: boolean;
  /** Runs the conflict check path immediately (e.g. on blur or modal open). */
  readonly triggerConflictCheck: () => void;
}

function buildNameTriggerText(input: IntakePreviewInput): string {
  return [
    input.firstName,
    input.surname,
    input.lastName,
    input.preferredName,
    input.legalName,
    input.callingOnBehalfOf,
    input.otherPartiesNamed,
    ...(input.otherNames ?? []),
  ]
    .map((s) => s?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

function hasAnyPreviewSignal(input: IntakePreviewInput): boolean {
  const nameText = buildNameTriggerText(input);
  if (nameText.length > 0) return true;
  if (input.companyNumber?.trim()) return true;
  if ((input.emails ?? []).some((e) => e.trim().length > 0)) return true;
  if ((input.phones ?? []).some((p) => p.trim().length > 0)) return true;
  if (
    (input.addresses ?? []).some(
      (a) =>
        (a.postcode?.trim() ?? '').length > 0 ||
        (a.line1?.trim() ?? '').length > 0,
    )
  ) {
    return true;
  }
  if (input.linkedPersonId?.trim() || input.linkedOrganisationId?.trim()) return true;
  return false;
}

/**
 * Dual-debounced C2 intake preview hook:
 * - Fast channel (`280ms`): SQL duplicate & known-entity checks (`includeConflicts: false`).
 * - Conflict channel (`>= 650ms` when trimmed name fields >= 3 chars, or immediately
 *   via `triggerConflictCheck` on blur / modal open): authoritative conflict preview (`B22`).
 * Stale responses are discarded via monotonic sequence numbers on both channels.
 */
export function useIntakePreview(
  input: IntakePreviewInput,
  options?: {
    readonly enabled?: boolean;
    readonly enableConflicts?: boolean;
  },
): UseIntakePreviewResult {
  const enabled = options?.enabled ?? true;
  const enableConflicts = options?.enableConflicts ?? true;
  const serializedInput = useMemo(() => JSON.stringify(input), [input]);
  const stableInput = useMemo<IntakePreviewInput>(
    () => JSON.parse(serializedInput) as IntakePreviewInput,
    [serializedInput],
  );

  const [fastResult, setFastResult] = useState<Pick<
    IntakePreviewResult,
    'duplicatePeople' | 'duplicateOrganisations' | 'entityMatches' | 'activeLinkedEnquiries'
  >>({
    duplicatePeople: [],
    duplicateOrganisations: [],
    entityMatches: { people: [], organisations: [] },
    activeLinkedEnquiries: [],
  });
  const [conflictResult, setConflictResult] = useState<
    Pick<IntakePreviewResult, 'possibleConflicts' | 'conflictSearch'>
  >({
    possibleConflicts: [],
    conflictSearch: null,
  });
  const [loadingFast, setLoadingFast] = useState(false);
  const [loadingConflicts, setLoadingConflicts] = useState(false);

  const fastSeqRef = useRef(0);
  const conflictSeqRef = useRef(0);
  const lastConflictPayloadKeyRef = useRef<string | null>(null);
  const latestInputRef = useRef<IntakePreviewInput>(stableInput);
  useEffect(() => {
    latestInputRef.current = stableInput;
  }, [stableInput]);

  const hasSignal = useMemo(() => hasAnyPreviewSignal(stableInput), [stableInput]);
  const nameCharCount = useMemo(
    () => buildNameTriggerText(stableInput).length,
    [stableInput],
  );

  // Fast channel: 280ms debounce for duplicates, known entities, and active enquiries.
  useEffect(() => {
    if (!enabled || !hasSignal) {
      fastSeqRef.current += 1;
      const resetTimer = setTimeout(() => {
        setFastResult({
          duplicatePeople: [],
          duplicateOrganisations: [],
          entityMatches: { people: [], organisations: [] },
          activeLinkedEnquiries: [],
        });
        setLoadingFast(false);
      }, 0);
      return () => clearTimeout(resetTimer);
    }

    let cancelled = false;
    const seq = ++fastSeqRef.current;

    const timer = setTimeout(() => {
      if (cancelled) return;
      setLoadingFast(true);
      void previewIntakeDuplicatesAndConflictsAction({
        ...stableInput,
        includeConflicts: false,
      })
        .then((res) => {
          if (cancelled || seq !== fastSeqRef.current) return;
          if (!isActionDenied(res)) {
            setFastResult({
              duplicatePeople: res.duplicatePeople,
              duplicateOrganisations: res.duplicateOrganisations,
              entityMatches: res.entityMatches,
              activeLinkedEnquiries: res.activeLinkedEnquiries,
            });
          }
          setLoadingFast(false);
        })
        .catch(() => {
          if (cancelled || seq !== fastSeqRef.current) return;
          setLoadingFast(false);
        });
    }, INTAKE_FAST_PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, hasSignal, stableInput]);

  const executeConflictPreview = useCallback((payload: IntakePreviewInput) => {
    const payloadKey = JSON.stringify({ ...payload, includeConflicts: true });
    if (lastConflictPayloadKeyRef.current === payloadKey) {
      return;
    }
    lastConflictPayloadKeyRef.current = payloadKey;
    const seq = ++conflictSeqRef.current;
    setLoadingConflicts(true);
    void previewIntakeDuplicatesAndConflictsAction({
      ...payload,
      includeConflicts: true,
    })
      .then((res) => {
        if (seq !== conflictSeqRef.current) return;
        if (!isActionDenied(res)) {
          setConflictResult({
            possibleConflicts: res.possibleConflicts,
            conflictSearch: res.conflictSearch,
          });
        }
        setLoadingConflicts(false);
      })
      .catch(() => {
        if (seq !== conflictSeqRef.current) return;
        setLoadingConflicts(false);
      });
  }, []);

  // Conflict channel: settled >= 650ms debounce only when trimmed name text >= 3 chars
  // (or when a person/org entity link is explicitly attached).
  useEffect(() => {
    if (!enabled || !enableConflicts || !hasSignal) {
      conflictSeqRef.current += 1;
      lastConflictPayloadKeyRef.current = null;
      const resetTimer = setTimeout(() => {
        setConflictResult({ possibleConflicts: [], conflictSearch: null });
        setLoadingConflicts(false);
      }, 0);
      return () => clearTimeout(resetTimer);
    }

    const meetsSettledNameGate =
      nameCharCount >= INTAKE_CONFLICT_MIN_NAME_CHARS ||
      Boolean(stableInput.linkedPersonId || stableInput.linkedOrganisationId);
    if (!meetsSettledNameGate) {
      return;
    }

    let cancelled = false;
    const seq = ++conflictSeqRef.current;
    const payloadKey = JSON.stringify({ ...stableInput, includeConflicts: true });

    const timer = setTimeout(() => {
      if (cancelled) return;
      if (lastConflictPayloadKeyRef.current === payloadKey) return;
      lastConflictPayloadKeyRef.current = payloadKey;
      setLoadingConflicts(true);
      void previewIntakeDuplicatesAndConflictsAction({
        ...stableInput,
        includeConflicts: true,
      })
        .then((res) => {
          if (cancelled || seq !== conflictSeqRef.current) return;
          if (!isActionDenied(res)) {
            setConflictResult({
              possibleConflicts: res.possibleConflicts,
              conflictSearch: res.conflictSearch,
            });
          }
          setLoadingConflicts(false);
        })
        .catch(() => {
          if (cancelled || seq !== conflictSeqRef.current) return;
          setLoadingConflicts(false);
        });
    }, INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, enableConflicts, hasSignal, nameCharCount, stableInput]);

  const triggerConflictCheck = useCallback(() => {
    if (!enabled || !enableConflicts) return;
    const payload = latestInputRef.current;
    if (!hasAnyPreviewSignal(payload)) return;
    lastConflictPayloadKeyRef.current = null;
    executeConflictPreview(payload);
  }, [enabled, enableConflicts, executeConflictPreview]);

  const preview = useMemo<IntakePreviewResult>(
    () => ({
      duplicatePeople: fastResult.duplicatePeople,
      duplicateOrganisations: fastResult.duplicateOrganisations,
      entityMatches: fastResult.entityMatches,
      activeLinkedEnquiries: fastResult.activeLinkedEnquiries,
      possibleConflicts: conflictResult.possibleConflicts,
      conflictSearch: conflictResult.conflictSearch,
    }),
    [fastResult, conflictResult],
  );

  return {
    preview,
    loadingFast,
    loadingConflicts,
    triggerConflictCheck,
  };
}
