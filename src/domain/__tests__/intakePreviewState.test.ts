import { describe, expect, it } from 'vitest';
import {
  INITIAL_INTAKE_PREVIEW_HOOK_STATE,
  INTAKE_PREVIEW_ERROR_MESSAGES,
  meetsConflictSettledGate,
  reduceIntakePreviewHookState,
  resolveConvertConflictModalState,
} from '../intakePreviewState';

describe('R714: intake preview hook state & Convert modal gating', () => {
  it('clears stale conflict hits and errors when trimmed name drops below 3 characters', () => {
    const withConflict = reduceIntakePreviewHookState(
      INITIAL_INTAKE_PREVIEW_HOOK_STATE,
      {
        type: 'CONFLICT_SUCCESS',
        payload: {
          possibleConflicts: [
            {
              recordType: 'matter',
              recordId: 'M-000001',
              name: 'Sample matter',
              recordLabel: 'PEN001-0001',
              queryTerm: 'Sample',
              href: '/matters/M-000001',
              reason: 'party match',
              reasons: ['party match'],
              matchedFields: ['party'],
              severity: 'high',
              strength: 100,
              blocking: true,
            },
          ],
          conflictSearch: {
            otherPartyClientMatches: [],
            clientAgainstPartyMatches: [],
            allConflicts: [],
            hasBlockingConflict: false,
          },
        },
      },
    );
    expect(withConflict.conflictResult.possibleConflicts).toHaveLength(1);
    expect(withConflict.conflictResult.conflictSearch).not.toBeNull();

    expect(meetsConflictSettledGate(2, 3, {})).toBe(false);
    expect(meetsConflictSettledGate(2, 3, { linkedPersonId: 'P-000013' })).toBe(true);
    expect(meetsConflictSettledGate(3, 3, {})).toBe(true);

    const cleared = reduceIntakePreviewHookState(withConflict, {
      type: 'CLEAR_CONFLICTS_BELOW_THRESHOLD',
    });
    expect(cleared.conflictResult.possibleConflicts).toEqual([]);
    expect(cleared.conflictResult.conflictSearch).toBeNull();
    expect(cleared.conflictError).toBeNull();
    expect(cleared.loadingConflicts).toBe(false);
  });

  it('surfaces fast duplicate and conflict preview errors and clears them on retry success', () => {
    const loadingFastState = reduceIntakePreviewHookState(
      INITIAL_INTAKE_PREVIEW_HOOK_STATE,
      { type: 'FAST_START' },
    );
    expect(loadingFastState.loadingFast).toBe(true);

    const failedFast = reduceIntakePreviewHookState(loadingFastState, {
      type: 'FAST_ERROR',
      message: 'FORBIDDEN',
    });
    expect(failedFast.loadingFast).toBe(false);
    expect(failedFast.fastError).toBe(
      INTAKE_PREVIEW_ERROR_MESSAGES.duplicates,
    );

    const recoveredFast = reduceIntakePreviewHookState(failedFast, {
      type: 'FAST_SUCCESS',
      payload: {
        duplicatePeople: [],
        duplicateOrganisations: [],
        entityMatches: { people: [], organisations: [] },
        activeLinkedEnquiries: [],
      },
    });
    expect(recoveredFast.fastError).toBeNull();

    const failedConflict = reduceIntakePreviewHookState(
      INITIAL_INTAKE_PREVIEW_HOOK_STATE,
      { type: 'CONFLICT_ERROR', message: 'Network error' },
    );
    expect(failedConflict.loadingConflicts).toBe(false);
    expect(failedConflict.conflictError).toBe(
      INTAKE_PREVIEW_ERROR_MESSAGES.conflicts,
    );
    expect(failedConflict.conflictResult.conflictSearch).toBeNull();
  });

  it('disables Continue in Convert modal while loading, unexecuted, errored, or blocked', () => {
    const pendingBeforeResult = resolveConvertConflictModalState({
      loadingConflicts: false,
      conflictError: null,
      conflictSearch: null,
    });
    expect(pendingBeforeResult).toEqual({
      status: 'loading',
      canContinue: false,
      errorMessage: null,
    });

    const activelyLoading = resolveConvertConflictModalState({
      loadingConflicts: true,
      conflictError: null,
      conflictSearch: {
        otherPartyClientMatches: [],
        clientAgainstPartyMatches: [],
        allConflicts: [],
        hasBlockingConflict: false,
      },
    });
    expect(activelyLoading.status).toBe('loading');
    expect(activelyLoading.canContinue).toBe(false);

    const errored = resolveConvertConflictModalState({
      loadingConflicts: false,
      conflictError: INTAKE_PREVIEW_ERROR_MESSAGES.conflicts,
      conflictSearch: null,
    });
    expect(errored).toEqual({
      status: 'error',
      canContinue: false,
      errorMessage: INTAKE_PREVIEW_ERROR_MESSAGES.conflicts,
    });

    const blocked = resolveConvertConflictModalState({
      loadingConflicts: false,
      conflictError: null,
      conflictSearch: {
        otherPartyClientMatches: [],
        clientAgainstPartyMatches: [],
        allConflicts: [],
        hasBlockingConflict: true,
      },
    });
    expect(blocked.status).toBe('blocking_conflict');
    expect(blocked.canContinue).toBe(false);

    const clearToContinue = resolveConvertConflictModalState({
      loadingConflicts: false,
      conflictError: null,
      conflictSearch: {
        otherPartyClientMatches: [],
        clientAgainstPartyMatches: [],
        allConflicts: [],
        hasBlockingConflict: false,
      },
    });
    expect(clearToContinue).toEqual({
      status: 'ready',
      canContinue: true,
      errorMessage: null,
    });
  });
});
