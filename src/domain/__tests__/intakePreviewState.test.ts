import { describe, expect, it } from 'vitest';
import {
  INITIAL_INTAKE_PREVIEW_HOOK_STATE,
  INTAKE_PREVIEW_ERROR_MESSAGES,
  meetsConflictSettledGate,
  reduceIntakePreviewHookState,
  resolveConvertConflictModalState,
  shouldShowNoMatchesMessage,
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
    expect(failedConflict.conflictChecked).toBe(false);
    expect(failedConflict.conflictResult.conflictSearch).toBeNull();

    const rateLimitedConflict = reduceIntakePreviewHookState(
      INITIAL_INTAKE_PREVIEW_HOOK_STATE,
      {
        type: 'CONFLICT_ERROR',
        code: 'RATE_LIMITED',
        message: 'Conflict preview rate limit exceeded.',
      },
    );
    expect(rateLimitedConflict.loadingConflicts).toBe(false);
    expect(rateLimitedConflict.conflictError).toBe(
      INTAKE_PREVIEW_ERROR_MESSAGES.rateLimited,
    );
    expect(rateLimitedConflict.conflictChecked).toBe(false);

    const insufficientDetail = reduceIntakePreviewHookState(
      INITIAL_INTAKE_PREVIEW_HOOK_STATE,
      { type: 'CONFLICT_INSUFFICIENT_DETAIL' },
    );
    expect(insufficientDetail.loadingConflicts).toBe(false);
    expect(insufficientDetail.conflictError).toBeNull();
    expect(insufficientDetail.conflictChecked).toBe(true);
    expect(insufficientDetail.conflictResult.conflictSearch).toBeNull();
  });

  it('hides the no-matches message while loading, on error, without inputs, or with matches (R723)', () => {
    expect(
      shouldShowNoMatchesMessage({
        hasSearchInputs: true,
        loadingFast: true,
        loadingConflicts: false,
        fastError: null,
        conflictError: null,
        matchCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowNoMatchesMessage({
        hasSearchInputs: true,
        loadingFast: false,
        loadingConflicts: true,
        fastError: null,
        conflictError: null,
        matchCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowNoMatchesMessage({
        hasSearchInputs: true,
        loadingFast: false,
        loadingConflicts: false,
        fastError: INTAKE_PREVIEW_ERROR_MESSAGES.duplicates,
        conflictError: null,
        matchCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowNoMatchesMessage({
        hasSearchInputs: true,
        loadingFast: false,
        loadingConflicts: false,
        fastError: null,
        conflictError: INTAKE_PREVIEW_ERROR_MESSAGES.conflicts,
        matchCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowNoMatchesMessage({
        hasSearchInputs: false,
        loadingFast: false,
        loadingConflicts: false,
        fastError: null,
        conflictError: null,
        matchCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowNoMatchesMessage({
        hasSearchInputs: true,
        loadingFast: false,
        loadingConflicts: false,
        fastError: null,
        conflictError: null,
        matchCount: 2,
      }),
    ).toBe(false);
    expect(
      shouldShowNoMatchesMessage({
        hasSearchInputs: true,
        loadingFast: false,
        loadingConflicts: false,
        fastError: null,
        conflictError: null,
        matchCount: 0,
      }),
    ).toBe(true);
  });

  it('disables Continue in Convert modal while loading, unexecuted, errored, or blocked, and allows Continue on not_enough_detail', () => {
    const pendingBeforeResult = resolveConvertConflictModalState({
      loadingConflicts: false,
      conflictError: null,
      conflictSearch: null,
      conflictChecked: false,
    });
    expect(pendingBeforeResult).toEqual({
      status: 'loading',
      canContinue: false,
      errorMessage: null,
    });

    const insufficientAfterCheck = resolveConvertConflictModalState({
      loadingConflicts: false,
      conflictError: null,
      conflictSearch: null,
      conflictChecked: true,
    });
    expect(insufficientAfterCheck).toEqual({
      status: 'not_enough_detail',
      canContinue: true,
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
