'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { previewIntakeDuplicatesAndConflictsAction } from '@/app/actions';
import { isActionDenied } from '@/domain/actionResult';
import {
  EMPTY_INTAKE_CONFLICT_SLICE,
  EMPTY_INTAKE_FAST_SLICE,
  INITIAL_INTAKE_PREVIEW_HOOK_STATE,
  meetsConflictSettledGate,
  reduceIntakePreviewHookState,
} from '@/domain/intakePreviewState';
import type {
  IntakePreviewInput,
  IntakePreviewResult,
} from '@/domain/intakePreviewTypes';

export const INTAKE_FAST_PREVIEW_DEBOUNCE_MS = 280;
export const INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS = 650;
export const INTAKE_CONFLICT_MIN_NAME_CHARS = 3;

export const EMPTY_INTAKE_PREVIEW_RESULT: IntakePreviewResult = {
  ...EMPTY_INTAKE_FAST_SLICE,
  ...EMPTY_INTAKE_CONFLICT_SLICE,
};

export interface UseIntakePreviewResult {
  readonly preview: IntakePreviewResult;
  readonly loadingFast: boolean;
  readonly loadingConflicts: boolean;
  readonly fastError: string | null;
  readonly conflictError: string | null;
  /** Runs the conflict check path immediately (e.g. on blur or modal open). */
  readonly triggerConflictCheck: () => void;
  /** Retries the fast duplicate preview check after an error. */
  readonly retryFastCheck: () => void;
  /** Retries the settled conflict check after an error. */
  readonly retryConflictCheck: () => void;
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
 * Stale responses are discarded via monotonic sequence numbers on both channels, and errors
 * are surfaced visibly (`R714`) rather than leaving silent "no matches".
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

  const [state, dispatch] = useReducer(
    reduceIntakePreviewHookState,
    INITIAL_INTAKE_PREVIEW_HOOK_STATE,
  );
  const [fastRetryKey, setFastRetryKey] = useState(0);

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
        dispatch({ type: 'FAST_RESET' });
      }, 0);
      return () => clearTimeout(resetTimer);
    }

    let cancelled = false;
    const seq = ++fastSeqRef.current;

    const timer = setTimeout(() => {
      if (cancelled) return;
      dispatch({ type: 'FAST_START' });
      void previewIntakeDuplicatesAndConflictsAction({
        ...stableInput,
        includeConflicts: false,
      })
        .then((res) => {
          if (cancelled || seq !== fastSeqRef.current) return;
          if (isActionDenied(res)) {
            dispatch({ type: 'FAST_ERROR', message: res.message });
          } else {
            dispatch({
              type: 'FAST_SUCCESS',
              payload: {
                duplicatePeople: res.duplicatePeople,
                duplicateOrganisations: res.duplicateOrganisations,
                entityMatches: res.entityMatches,
                activeLinkedEnquiries: res.activeLinkedEnquiries,
              },
            });
          }
        })
        .catch(() => {
          if (cancelled || seq !== fastSeqRef.current) return;
          dispatch({ type: 'FAST_ERROR' });
        });
    }, INTAKE_FAST_PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, hasSignal, stableInput, fastRetryKey]);

  const executeConflictPreview = useCallback((payload: IntakePreviewInput) => {
    const payloadKey = JSON.stringify({ ...payload, includeConflicts: true });
    if (lastConflictPayloadKeyRef.current === payloadKey) {
      return;
    }
    lastConflictPayloadKeyRef.current = payloadKey;
    const seq = ++conflictSeqRef.current;
    dispatch({ type: 'CONFLICT_START' });
    void previewIntakeDuplicatesAndConflictsAction({
      ...payload,
      includeConflicts: true,
    })
      .then((res) => {
        if (seq !== conflictSeqRef.current) return;
        if (isActionDenied(res)) {
          lastConflictPayloadKeyRef.current = null;
          dispatch({ type: 'CONFLICT_ERROR', message: res.message });
        } else {
          dispatch({
            type: 'CONFLICT_SUCCESS',
            payload: {
              possibleConflicts: res.possibleConflicts,
              conflictSearch: res.conflictSearch,
            },
          });
        }
      })
      .catch(() => {
        if (seq !== conflictSeqRef.current) return;
        lastConflictPayloadKeyRef.current = null;
        dispatch({ type: 'CONFLICT_ERROR' });
      });
  }, []);

  // Conflict channel: settled >= 650ms debounce only when trimmed name text >= 3 chars
  // (or when a person/org entity link is explicitly attached). Clears stale hits below threshold.
  useEffect(() => {
    if (!enabled || !enableConflicts || !hasSignal) {
      conflictSeqRef.current += 1;
      lastConflictPayloadKeyRef.current = null;
      const resetTimer = setTimeout(() => {
        dispatch({ type: 'CONFLICT_RESET' });
      }, 0);
      return () => clearTimeout(resetTimer);
    }

    if (
      !meetsConflictSettledGate(
        nameCharCount,
        INTAKE_CONFLICT_MIN_NAME_CHARS,
        stableInput,
      )
    ) {
      conflictSeqRef.current += 1;
      lastConflictPayloadKeyRef.current = null;
      const clearTimer = setTimeout(() => {
        dispatch({ type: 'CLEAR_CONFLICTS_BELOW_THRESHOLD' });
      }, 0);
      return () => clearTimeout(clearTimer);
    }

    let cancelled = false;
    const seq = ++conflictSeqRef.current;
    const payloadKey = JSON.stringify({ ...stableInput, includeConflicts: true });

    const timer = setTimeout(() => {
      if (cancelled) return;
      if (lastConflictPayloadKeyRef.current === payloadKey) return;
      lastConflictPayloadKeyRef.current = payloadKey;
      dispatch({ type: 'CONFLICT_START' });
      void previewIntakeDuplicatesAndConflictsAction({
        ...stableInput,
        includeConflicts: true,
      })
        .then((res) => {
          if (cancelled || seq !== conflictSeqRef.current) return;
          if (isActionDenied(res)) {
            lastConflictPayloadKeyRef.current = null;
            dispatch({ type: 'CONFLICT_ERROR', message: res.message });
          } else {
            dispatch({
              type: 'CONFLICT_SUCCESS',
              payload: {
                possibleConflicts: res.possibleConflicts,
                conflictSearch: res.conflictSearch,
              },
            });
          }
        })
        .catch(() => {
          if (cancelled || seq !== conflictSeqRef.current) return;
          lastConflictPayloadKeyRef.current = null;
          dispatch({ type: 'CONFLICT_ERROR' });
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

  const retryFastCheck = useCallback(() => {
    if (!enabled) return;
    setFastRetryKey((k) => k + 1);
  }, [enabled]);

  const preview = useMemo<IntakePreviewResult>(
    () => ({
      duplicatePeople: state.fastResult.duplicatePeople,
      duplicateOrganisations: state.fastResult.duplicateOrganisations,
      entityMatches: state.fastResult.entityMatches,
      activeLinkedEnquiries: state.fastResult.activeLinkedEnquiries,
      possibleConflicts: state.conflictResult.possibleConflicts,
      conflictSearch: state.conflictResult.conflictSearch,
    }),
    [state.fastResult, state.conflictResult],
  );

  return {
    preview,
    loadingFast: state.loadingFast,
    loadingConflicts: state.loadingConflicts,
    fastError: state.fastError,
    conflictError: state.conflictError,
    triggerConflictCheck,
    retryFastCheck,
    retryConflictCheck: triggerConflictCheck,
  };
}
