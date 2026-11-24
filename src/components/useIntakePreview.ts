'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { previewIntakeDuplicatesAndConflictsAction } from '@/app/actions';
import {
  createIntakePreviewController,
  INTAKE_CONFLICT_MIN_NAME_CHARS,
  INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS,
  INTAKE_FAST_PREVIEW_DEBOUNCE_MS,
  type IntakePreviewController,
} from '@/domain/intakePreviewController';
import {
  EMPTY_INTAKE_CONFLICT_SLICE,
  EMPTY_INTAKE_FAST_SLICE,
  INITIAL_INTAKE_PREVIEW_HOOK_STATE,
  reduceIntakePreviewHookState,
} from '@/domain/intakePreviewState';
import type {
  IntakePreviewInput,
  IntakePreviewResult,
} from '@/domain/intakePreviewTypes';

export {
  INTAKE_CONFLICT_MIN_NAME_CHARS,
  INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS,
  INTAKE_FAST_PREVIEW_DEBOUNCE_MS,
};

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
  readonly conflictChecked: boolean;
  /** Runs the conflict check path immediately on blur or modal open (deduplicated per unchanged input). */
  readonly triggerConflictCheck: () => void;
  /** Retries the fast duplicate preview check after an error. */
  readonly retryFastCheck: () => void;
  /** Retries the settled conflict check explicitly after an error. */
  readonly retryConflictCheck: () => void;
}

/**
 * Dual-debounced C2 intake preview hook:
 * - Fast channel (`280ms`): SQL duplicate & known-entity checks (`includeConflicts: false`).
 * - Conflict channel (`>= 650ms` when trimmed name fields >= 3 chars, or immediately
 *   via `triggerConflictCheck` on blur / modal open): authoritative conflict preview (`B22`).
 * Stale responses are discarded via monotonic sequence numbers on both channels, unchanged
 * blur checks are deduplicated, and errors (including `RATE_LIMITED`) are surfaced visibly
 * (`R714`, `R723`, `R724`).
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

  const controllerRef = useRef<IntakePreviewController | null>(null);

  useEffect(() => {
    const controller = createIntakePreviewController({
      action: (payload) => previewIntakeDuplicatesAndConflictsAction(payload),
      dispatch,
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.sync(stableInput, { enabled, enableConflicts });
  }, [stableInput, enabled, enableConflicts]);

  const triggerConflictCheck = useCallback(() => {
    controllerRef.current?.triggerConflictCheck();
  }, []);

  const retryFastCheck = useCallback(() => {
    controllerRef.current?.retryFastCheck();
  }, []);

  const retryConflictCheck = useCallback(() => {
    controllerRef.current?.retryConflictCheck();
  }, []);

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
    conflictChecked: state.conflictChecked,
    triggerConflictCheck,
    retryFastCheck,
    retryConflictCheck,
  };
}
