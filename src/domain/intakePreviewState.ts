import type {
  IntakePreviewInput,
  IntakePreviewResult,
} from './intakePreviewTypes';

type ConflictSearchResult = NonNullable<IntakePreviewResult['conflictSearch']>;
type PreliminaryConflictHit =
  IntakePreviewResult['possibleConflicts'][number];

export const INTAKE_PREVIEW_ERROR_MESSAGES = {
  duplicates: "Couldn't check for duplicates. Try again.",
  conflicts: "Couldn't complete conflict check. Try again.",
  picker: "Couldn't search directory. Try again.",
} as const;

export type IntakeFastPreviewSlice = Pick<
  IntakePreviewResult,
  | 'duplicatePeople'
  | 'duplicateOrganisations'
  | 'entityMatches'
  | 'activeLinkedEnquiries'
>;

export type IntakeConflictPreviewSlice = Pick<
  IntakePreviewResult,
  'possibleConflicts' | 'conflictSearch'
>;

export const EMPTY_INTAKE_FAST_SLICE: IntakeFastPreviewSlice = {
  duplicatePeople: [],
  duplicateOrganisations: [],
  entityMatches: { people: [], organisations: [] },
  activeLinkedEnquiries: [],
};

export const EMPTY_INTAKE_CONFLICT_SLICE: IntakeConflictPreviewSlice = {
  possibleConflicts: [],
  conflictSearch: null,
};

export interface IntakePreviewHookState {
  readonly fastResult: IntakeFastPreviewSlice;
  readonly conflictResult: IntakeConflictPreviewSlice;
  readonly loadingFast: boolean;
  readonly loadingConflicts: boolean;
  readonly fastError: string | null;
  readonly conflictError: string | null;
}

export const INITIAL_INTAKE_PREVIEW_HOOK_STATE: IntakePreviewHookState = {
  fastResult: EMPTY_INTAKE_FAST_SLICE,
  conflictResult: EMPTY_INTAKE_CONFLICT_SLICE,
  loadingFast: false,
  loadingConflicts: false,
  fastError: null,
  conflictError: null,
};

export type IntakePreviewHookAction =
  | { readonly type: 'FAST_RESET' }
  | { readonly type: 'FAST_START' }
  | {
      readonly type: 'FAST_SUCCESS';
      readonly payload: IntakeFastPreviewSlice;
    }
  | { readonly type: 'FAST_ERROR'; readonly message?: string }
  | { readonly type: 'CONFLICT_RESET' }
  | { readonly type: 'CLEAR_CONFLICTS_BELOW_THRESHOLD' }
  | { readonly type: 'CONFLICT_START' }
  | {
      readonly type: 'CONFLICT_SUCCESS';
      readonly payload: {
        readonly possibleConflicts: readonly PreliminaryConflictHit[];
        readonly conflictSearch: ConflictSearchResult | null;
      };
    }
  | { readonly type: 'CONFLICT_ERROR'; readonly message?: string };

export function reduceIntakePreviewHookState(
  state: IntakePreviewHookState,
  action: IntakePreviewHookAction,
): IntakePreviewHookState {
  switch (action.type) {
    case 'FAST_RESET':
      return {
        ...state,
        fastResult: EMPTY_INTAKE_FAST_SLICE,
        loadingFast: false,
        fastError: null,
      };
    case 'FAST_START':
      return {
        ...state,
        loadingFast: true,
        fastError: null,
      };
    case 'FAST_SUCCESS':
      return {
        ...state,
        fastResult: action.payload,
        loadingFast: false,
        fastError: null,
      };
    case 'FAST_ERROR':
      return {
        ...state,
        fastResult: EMPTY_INTAKE_FAST_SLICE,
        loadingFast: false,
        fastError: INTAKE_PREVIEW_ERROR_MESSAGES.duplicates,
      };
    case 'CONFLICT_RESET':
    case 'CLEAR_CONFLICTS_BELOW_THRESHOLD':
      return {
        ...state,
        conflictResult: EMPTY_INTAKE_CONFLICT_SLICE,
        loadingConflicts: false,
        conflictError: null,
      };
    case 'CONFLICT_START':
      return {
        ...state,
        loadingConflicts: true,
        conflictError: null,
      };
    case 'CONFLICT_SUCCESS':
      return {
        ...state,
        conflictResult: {
          possibleConflicts: [...action.payload.possibleConflicts],
          conflictSearch: action.payload.conflictSearch,
        },
        loadingConflicts: false,
        conflictError: null,
      };
    case 'CONFLICT_ERROR':
      return {
        ...state,
        conflictResult: EMPTY_INTAKE_CONFLICT_SLICE,
        loadingConflicts: false,
        conflictError: INTAKE_PREVIEW_ERROR_MESSAGES.conflicts,
      };
    default:
      return state;
  }
}

export function meetsConflictSettledGate(
  nameCharCount: number,
  minNameChars: number,
  input: Pick<IntakePreviewInput, 'linkedPersonId' | 'linkedOrganisationId'>,
): boolean {
  return (
    nameCharCount >= minNameChars ||
    Boolean(input.linkedPersonId?.trim() || input.linkedOrganisationId?.trim())
  );
}

export interface ConvertConflictModalState {
  readonly status: 'loading' | 'error' | 'blocking_conflict' | 'ready';
  readonly canContinue: boolean;
  readonly errorMessage: string | null;
}

/**
 * Resolves Convert-to-Matter modal conflict-check state (`R714`):
 * never reports "No blocking conflicts found" or allows Continue while the
 * check is still pending, unexecuted (`conflictSearch === null`), or failed.
 */
export function resolveConvertConflictModalState(input: {
  readonly loadingConflicts: boolean;
  readonly conflictError: string | null;
  readonly conflictSearch: ConflictSearchResult | null;
}): ConvertConflictModalState {
  if (input.loadingConflicts) {
    return { status: 'loading', canContinue: false, errorMessage: null };
  }
  if (input.conflictError) {
    return {
      status: 'error',
      canContinue: false,
      errorMessage: input.conflictError,
    };
  }
  if (!input.conflictSearch) {
    return { status: 'loading', canContinue: false, errorMessage: null };
  }
  if (input.conflictSearch.hasBlockingConflict) {
    return {
      status: 'blocking_conflict',
      canContinue: false,
      errorMessage: null,
    };
  }
  return { status: 'ready', canContinue: true, errorMessage: null };
}
