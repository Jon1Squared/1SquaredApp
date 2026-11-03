/**
 * Bespoke Client Extension: `nalf-matter-costs-governance`
 *
 * Rules enforced:
 * - Imports ONLY from `@platform/core-api` (never from core internals).
 * - Uses only public extension hooks (`beforeMatterCostsCalculate` & `beforeMatterOpen`).
 */

import type {
  ExtensionExecutionContext,
  MatterCostsHookInput,
  MatterCostsHookResult,
  PlatformExtension,
} from '@platform/core-api';
import manifestJson from '../manifest.json' with { type: 'json' };

function evaluatePartnerCostGovernance(
  ctx: ExtensionExecutionContext,
  input: MatterCostsHookInput,
  stage: 'calculate' | 'open',
): MatterCostsHookResult {
  const threshold = ctx.config.matterCosts.partnerSignOffThresholdGbp ?? 25000;
  const requiresPartnerSignOff = input.estimatedFeeGbp >= threshold;
  const warnings: string[] = [];

  if (requiresPartnerSignOff && !input.partnerSignOffCompleted) {
    warnings.push(
      `Estimated fee (£${input.estimatedFeeGbp.toLocaleString('en-GB')}) meets or exceeds the £${threshold.toLocaleString('en-GB')} Partner Cost Sign-off threshold.`,
    );
  }

  return {
    requiresPartnerSignOff,
    governanceWarnings: warnings,
    allowProceed:
      stage === 'open'
        ? !requiresPartnerSignOff || input.partnerSignOffCompleted
        : true,
  };
}

export const notALawFirmMatterCostsExtension: PlatformExtension = {
  manifest: {
    id: manifestJson.id,
    name: manifestJson.name,
    version: manifestJson.version,
    description: manifestJson.description,
    supportedCoreApiRange: manifestJson.supportedCoreApiRange,
    permissions: [
      'matter:read',
      'matter:costs:validate',
      'matter:open:gate',
      'config:read',
    ],
    hooks: ['beforeMatterCostsCalculate', 'beforeMatterOpen'],
    uiSlots: manifestJson.uiSlots,
    hookTimeoutMs: manifestJson.hookTimeoutMs,
  },
  hooks: {
    beforeMatterCostsCalculate(ctx, input) {
      return evaluatePartnerCostGovernance(ctx, input, 'calculate');
    },
    beforeMatterOpen(ctx, input) {
      return evaluatePartnerCostGovernance(ctx, input, 'open');
    },
  },
};
