import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildActionDenied } from '../actionResult';
import {
  createIntakePreviewController,
  INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS,
  INTAKE_FAST_PREVIEW_DEBOUNCE_MS,
  type IntakePreviewActionFn,
} from '../intakePreviewController';
import {
  EMPTY_INTAKE_CONFLICT_SLICE,
  EMPTY_INTAKE_FAST_SLICE,
  INITIAL_INTAKE_PREVIEW_HOOK_STATE,
  INTAKE_PREVIEW_ERROR_MESSAGES,
  reduceIntakePreviewHookState,
  resolveConvertConflictModalState,
  type IntakePreviewHookState,
} from '../intakePreviewState';
import type { IntakePreviewResult } from '../intakePreviewTypes';

function emptyResult(
  overrides?: Partial<IntakePreviewResult>,
): IntakePreviewResult {
  return {
    ...EMPTY_INTAKE_FAST_SLICE,
    ...EMPTY_INTAKE_CONFLICT_SLICE,
    ...overrides,
  };
}

function createHarness(actionImpl: IntakePreviewActionFn) {
  let state: IntakePreviewHookState = INITIAL_INTAKE_PREVIEW_HOOK_STATE;
  const action = vi.fn(actionImpl);
  const controller = createIntakePreviewController({
    action,
    dispatch(act) {
      state = reduceIntakePreviewHookState(state, act);
    },
  });
  return {
    controller,
    action,
    getState: () => state,
  };
}

describe('R723 / R724 / Suggestion 8: useIntakePreview controller wiring', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deduplicates repeated blur triggers on unchanged input and retries only on explicit retry (R724)', async () => {
    vi.useFakeTimers();
    const { controller, action, getState } = createHarness(async () =>
      emptyResult({
        conflictSearch: {
          otherPartyClientMatches: [],
          clientAgainstPartyMatches: [],
          allConflicts: [],
          hasBlockingConflict: false,
        },
      }),
    );

    controller.sync(
      {
        kind: 'enquiry',
        firstName: 'Al',
        lastName: '',
      },
      { enabled: true, enableConflicts: true },
    );

    // First blur sends one includeConflicts: true request
    controller.triggerConflictCheck();
    await vi.runAllTimersAsync();
    const conflictCallsAfterFirstBlur = action.mock.calls.filter(
      ([arg]) => arg.includeConflicts === true,
    );
    expect(conflictCallsAfterFirstBlur).toHaveLength(1);
    expect(getState().conflictChecked).toBe(true);

    // Second blur on the exact same unchanged input makes NO extra conflict call
    controller.triggerConflictCheck();
    await vi.runAllTimersAsync();
    expect(
      action.mock.calls.filter(([arg]) => arg.includeConflicts === true),
    ).toHaveLength(1);

    // Explicit retry forces a fresh conflict request
    controller.retryConflictCheck();
    await vi.runAllTimersAsync();
    expect(
      action.mock.calls.filter(([arg]) => arg.includeConflicts === true),
    ).toHaveLength(2);

    controller.dispose();
  });

  it('maps RATE_LIMITED denials from explicit retry to the rate-limited user message (R724)', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { controller, getState } = createHarness(async (input) => {
      if (input.includeConflicts) {
        calls += 1;
        if (calls >= 2) {
          return buildActionDenied(
            'RATE_LIMITED',
            'Conflict preview rate limit exceeded.',
          );
        }
      }
      return emptyResult({
        conflictSearch: {
          otherPartyClientMatches: [],
          clientAgainstPartyMatches: [],
          allConflicts: [],
          hasBlockingConflict: false,
        },
      });
    });

    controller.sync(
      { kind: 'quote', firstName: 'Seren', surname: 'Davies' },
      { enabled: true, enableConflicts: true },
    );
    await vi.advanceTimersByTimeAsync(INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS);
    expect(getState().conflictChecked).toBe(true);
    expect(getState().conflictError).toBeNull();

    controller.retryConflictCheck();
    await vi.runAllTimersAsync();
    expect(getState().conflictError).toBe(
      INTAKE_PREVIEW_ERROR_MESSAGES.rateLimited,
    );
    expect(getState().conflictChecked).toBe(false);

    controller.dispose();
  });

  it('clears stale conflict hits when name text drops below the 3-character settled gate (Suggestion 8)', async () => {
    vi.useFakeTimers();
    const { controller, action, getState } = createHarness(async () =>
      emptyResult({
        possibleConflicts: [
          {
            recordType: 'matter',
            recordId: 'M-000001',
            name: 'Sample matter',
            recordLabel: 'PEN001-0001',
            queryTerm: 'Seren',
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
          hasBlockingConflict: true,
        },
      }),
    );

    controller.sync(
      { kind: 'enquiry', firstName: 'Ser', lastName: '' },
      { enabled: true, enableConflicts: true },
    );
    await vi.advanceTimersByTimeAsync(INTAKE_FAST_PREVIEW_DEBOUNCE_MS);
    expect(
      action.mock.calls.filter(([arg]) => arg.includeConflicts === false),
    ).toHaveLength(1);
    expect(
      action.mock.calls.filter(([arg]) => arg.includeConflicts === true),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS);
    expect(getState().conflictResult.possibleConflicts).toHaveLength(1);

    // Drop name below 3 chars -> clears stale conflict slice
    controller.sync(
      { kind: 'enquiry', firstName: 'Se', lastName: '' },
      { enabled: true, enableConflicts: true },
    );
    await vi.runAllTimersAsync();
    expect(getState().conflictResult.possibleConflicts).toEqual([]);
    expect(getState().conflictResult.conflictSearch).toBeNull();
    expect(getState().conflictChecked).toBe(false);

    controller.dispose();
  });

  it('transitions Convert-modal trigger with no search signal or null conflictSearch into not_enough_detail (R723 / Suggestion 8)', async () => {
    vi.useFakeTimers();

    // Case A: Convert modal opened with empty detail (no signal at all)
    const emptyHarness = createHarness(async () => emptyResult());
    emptyHarness.controller.sync(
      { kind: 'enquiry', firstName: '', lastName: '' },
      { enabled: true, enableConflicts: true },
    );
    emptyHarness.controller.triggerConflictCheck();
    await vi.runAllTimersAsync();

    expect(emptyHarness.getState().conflictChecked).toBe(true);
    expect(
      resolveConvertConflictModalState({
        loadingConflicts: emptyHarness.getState().loadingConflicts,
        conflictError: emptyHarness.getState().conflictError,
        conflictSearch: emptyHarness.getState().conflictResult.conflictSearch,
        conflictChecked: emptyHarness.getState().conflictChecked,
      }),
    ).toEqual({
      status: 'not_enough_detail',
      canContinue: true,
      errorMessage: null,
    });
    emptyHarness.controller.dispose();

    // Case B: Server invoked with address line1 only (hasSignal=true on client, conflictSearch=null from server)
    const serverNullHarness = createHarness(async () =>
      emptyResult({ conflictSearch: null }),
    );
    serverNullHarness.controller.sync(
      {
        kind: 'enquiry',
        addresses: [{ line1: '10 High Street', postcode: '' }],
      },
      { enabled: true, enableConflicts: true },
    );
    serverNullHarness.controller.triggerConflictCheck();
    await vi.runAllTimersAsync();

    expect(serverNullHarness.getState().conflictChecked).toBe(true);
    expect(
      resolveConvertConflictModalState({
        loadingConflicts: serverNullHarness.getState().loadingConflicts,
        conflictError: serverNullHarness.getState().conflictError,
        conflictSearch:
          serverNullHarness.getState().conflictResult.conflictSearch,
        conflictChecked: serverNullHarness.getState().conflictChecked,
      }),
    ).toEqual({
      status: 'not_enough_detail',
      canContinue: true,
      errorMessage: null,
    });
    serverNullHarness.controller.dispose();
  });

  it('keeps resolving in-flight conflict result when typing extra char then backspacing within debounce window (Suggestion 2)', async () => {
    vi.useFakeTimers();
    const conflictResolvers: Array<(value: IntakePreviewResult) => void> = [];
    const { controller, action, getState } = createHarness(
      (input) =>
        new Promise((resolve) => {
          if (input.includeConflicts) {
            conflictResolvers.push(resolve);
            return;
          }
          resolve(emptyResult());
        }),
    );

    controller.sync(
      { kind: 'enquiry', firstName: 'Seren', lastName: '' },
      { enabled: true, enableConflicts: true },
    );
    await vi.advanceTimersByTimeAsync(INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS);
    expect(getState().loadingConflicts).toBe(true);
    expect(conflictResolvers).toHaveLength(1);
    expect(
      action.mock.calls.filter(([arg]) => arg.includeConflicts === true),
    ).toHaveLength(1);

    // Type 'x' then quickly backspace back to 'Seren' within 650ms
    controller.sync(
      { kind: 'enquiry', firstName: 'Serenx', lastName: '' },
      { enabled: true, enableConflicts: true },
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.sync(
      { kind: 'enquiry', firstName: 'Seren', lastName: '' },
      { enabled: true, enableConflicts: true },
    );

    // Resolve the original 'Seren' in-flight response — loadingConflicts must clear
    for (const resolve of conflictResolvers) {
      resolve(
        emptyResult({
          conflictSearch: {
            otherPartyClientMatches: [],
            clientAgainstPartyMatches: [],
            allConflicts: [],
            hasBlockingConflict: false,
          },
        }),
      );
    }
    await Promise.resolve();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(getState().loadingConflicts).toBe(false);
    expect(getState().conflictChecked).toBe(true);
    expect(
      action.mock.calls.filter(([arg]) => arg.includeConflicts === true),
    ).toHaveLength(1);

    controller.dispose();
  });
});
