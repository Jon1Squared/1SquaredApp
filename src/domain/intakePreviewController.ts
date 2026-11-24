import { isActionDenied, type ActionDenied } from './actionResult';
import {
  meetsConflictSettledGate,
  type IntakePreviewHookAction,
} from './intakePreviewState';
import type {
  IntakePreviewInput,
  IntakePreviewResult,
} from './intakePreviewTypes';

export const INTAKE_FAST_PREVIEW_DEBOUNCE_MS = 280;
export const INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS = 650;
export const INTAKE_CONFLICT_MIN_NAME_CHARS = 3;

export type IntakePreviewActionFn = (
  input: IntakePreviewInput,
) => Promise<IntakePreviewResult | ActionDenied>;

export function buildIntakeNameTriggerText(input: IntakePreviewInput): string {
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

export function hasAnyPreviewSignal(input: IntakePreviewInput): boolean {
  const nameText = buildIntakeNameTriggerText(input);
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
  if (input.linkedPersonId?.trim() || input.linkedOrganisationId?.trim()) {
    return true;
  }
  return false;
}

export interface IntakePreviewControllerConfig {
  readonly action: IntakePreviewActionFn;
  readonly dispatch: (action: IntakePreviewHookAction) => void;
  readonly fastDebounceMs?: number;
  readonly conflictDebounceMs?: number;
  readonly minConflictNameChars?: number;
}

export interface IntakePreviewController {
  sync(
    input: IntakePreviewInput,
    options?: {
      readonly enabled?: boolean;
      readonly enableConflicts?: boolean;
    },
  ): void;
  triggerConflictCheck(): void;
  retryFastCheck(): void;
  retryConflictCheck(): void;
  reactivate(): void;
  dispose(): void;
}

/**
 * Pure dual-channel intake preview controller (`R714`, `R723`, `R724`):
 * - Separates blur/open triggers (`triggerConflictCheck`, deduplicated via `lastConflictPayloadKey`)
 *   from explicit user retries (`retryConflictCheck`, clears key and propagates `RATE_LIMITED` codes).
 * - Dispatches `CONFLICT_INSUFFICIENT_DETAIL` when triggered without search detail so the Convert modal
 *   never hangs indefinitely on "Checking for conflicts…".
 */
export function createIntakePreviewController(
  config: IntakePreviewControllerConfig,
): IntakePreviewController {
  const fastDebounceMs =
    config.fastDebounceMs ?? INTAKE_FAST_PREVIEW_DEBOUNCE_MS;
  const conflictDebounceMs =
    config.conflictDebounceMs ?? INTAKE_CONFLICT_PREVIEW_DEBOUNCE_MS;
  const minConflictNameChars =
    config.minConflictNameChars ?? INTAKE_CONFLICT_MIN_NAME_CHARS;

  let disposed = false;
  let fastSeq = 0;
  let conflictSeq = 0;
  let fastTimer: ReturnType<typeof setTimeout> | null = null;
  let conflictTimer: ReturnType<typeof setTimeout> | null = null;
  let lastConflictPayloadKey: string | null = null;

  let latestSerializedInput: string | null = null;
  let latestInput: IntakePreviewInput | null = null;
  let latestEnabled = true;
  let latestEnableConflicts = true;

  function clearFastTimer(): void {
    if (fastTimer !== null) {
      clearTimeout(fastTimer);
      fastTimer = null;
    }
  }

  function clearConflictTimer(): void {
    if (conflictTimer !== null) {
      clearTimeout(conflictTimer);
      conflictTimer = null;
    }
  }

  function scheduleFastChannel(input: IntakePreviewInput, enabled: boolean): void {
    clearFastTimer();
    if (disposed) return;

    if (!enabled || !hasAnyPreviewSignal(input)) {
      fastSeq += 1;
      fastTimer = setTimeout(() => {
        fastTimer = null;
        if (disposed) return;
        config.dispatch({ type: 'FAST_RESET' });
      }, 0);
      return;
    }

    const seq = ++fastSeq;
    fastTimer = setTimeout(() => {
      fastTimer = null;
      if (disposed || seq !== fastSeq) return;
      config.dispatch({ type: 'FAST_START' });
      void config
        .action({
          ...input,
          includeConflicts: false,
        })
        .then((res) => {
          if (disposed || seq !== fastSeq) return;
          if (isActionDenied(res)) {
            config.dispatch({ type: 'FAST_ERROR', message: res.message });
          } else {
            config.dispatch({
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
          if (disposed || seq !== fastSeq) return;
          config.dispatch({ type: 'FAST_ERROR' });
        });
    }, fastDebounceMs);
  }

  function executeConflictPreview(
    payload: IntakePreviewInput,
    options: { readonly force: boolean },
  ): void {
    if (disposed) return;
    clearConflictTimer();

    if (!hasAnyPreviewSignal(payload)) {
      conflictSeq += 1;
      lastConflictPayloadKey = null;
      config.dispatch({ type: 'CONFLICT_INSUFFICIENT_DETAIL' });
      return;
    }

    const payloadKey = JSON.stringify({ ...payload, includeConflicts: true });
    if (!options.force && lastConflictPayloadKey === payloadKey) {
      return;
    }
    lastConflictPayloadKey = payloadKey;
    const seq = ++conflictSeq;
    config.dispatch({ type: 'CONFLICT_START' });

    void config
      .action({
        ...payload,
        includeConflicts: true,
      })
      .then((res) => {
        if (disposed || seq !== conflictSeq) return;
        if (isActionDenied(res)) {
          lastConflictPayloadKey = null;
          config.dispatch({
            type: 'CONFLICT_ERROR',
            message: res.message,
            code: res.code,
          });
        } else {
          config.dispatch({
            type: 'CONFLICT_SUCCESS',
            payload: {
              possibleConflicts: res.possibleConflicts,
              conflictSearch: res.conflictSearch,
            },
          });
        }
      })
      .catch(() => {
        if (disposed || seq !== conflictSeq) return;
        lastConflictPayloadKey = null;
        config.dispatch({ type: 'CONFLICT_ERROR' });
      });
  }

  function scheduleConflictChannel(
    input: IntakePreviewInput,
    enabled: boolean,
    enableConflicts: boolean,
  ): void {
    clearConflictTimer();
    if (disposed) return;

    if (!enabled || !enableConflicts || !hasAnyPreviewSignal(input)) {
      conflictSeq += 1;
      lastConflictPayloadKey = null;
      conflictTimer = setTimeout(() => {
        conflictTimer = null;
        if (disposed) return;
        config.dispatch({ type: 'CONFLICT_RESET' });
      }, 0);
      return;
    }

    const nameCharCount = buildIntakeNameTriggerText(input).length;
    if (
      !meetsConflictSettledGate(nameCharCount, minConflictNameChars, input)
    ) {
      conflictSeq += 1;
      lastConflictPayloadKey = null;
      conflictTimer = setTimeout(() => {
        conflictTimer = null;
        if (disposed) return;
        config.dispatch({ type: 'CLEAR_CONFLICTS_BELOW_THRESHOLD' });
      }, 0);
      return;
    }

    const payloadKey = JSON.stringify({ ...input, includeConflicts: true });
    if (lastConflictPayloadKey === payloadKey) {
      return;
    }
    conflictTimer = setTimeout(() => {
      conflictTimer = null;
      if (disposed) return;
      executeConflictPreview(input, { force: false });
    }, conflictDebounceMs);
  }

  return {
    sync(input, options) {
      const enabled = options?.enabled ?? true;
      const enableConflicts = options?.enableConflicts ?? true;
      const serialized = JSON.stringify(input);
      const stableInput = JSON.parse(serialized) as IntakePreviewInput;

      const inputChanged = serialized !== latestSerializedInput;
      const enabledChanged = enabled !== latestEnabled;
      const conflictsEnabledChanged = enableConflicts !== latestEnableConflicts;

      latestSerializedInput = serialized;
      latestInput = stableInput;
      latestEnabled = enabled;
      latestEnableConflicts = enableConflicts;

      if (inputChanged || enabledChanged) {
        scheduleFastChannel(stableInput, enabled);
      }
      if (inputChanged || enabledChanged || conflictsEnabledChanged) {
        scheduleConflictChannel(stableInput, enabled, enableConflicts);
      }
    },
    triggerConflictCheck() {
      if (disposed || !latestEnabled || !latestEnableConflicts || !latestInput) {
        return;
      }
      executeConflictPreview(latestInput, { force: false });
    },
    retryFastCheck() {
      if (disposed || !latestEnabled || !latestInput) return;
      scheduleFastChannel(latestInput, latestEnabled);
    },
    retryConflictCheck() {
      if (disposed || !latestEnabled || !latestEnableConflicts || !latestInput) {
        return;
      }
      executeConflictPreview(latestInput, { force: true });
    },
    reactivate() {
      if (disposed) {
        disposed = false;
        latestSerializedInput = null;
      }
    },
    dispose() {
      disposed = true;
      clearFastTimer();
      clearConflictTimer();
      fastSeq += 1;
      conflictSeq += 1;
    },
  };
}
