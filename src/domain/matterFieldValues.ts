export const SERVER_OWNED_MATTER_FIELD_KEYS = [
  'partnerCostSignOffCompleted',
  'partnerCostSignOff',
  'matterOpeningSnapshot',
  'matterCostsGovernance',
  'riskAssessment',
] as const;

export type ServerOwnedMatterFieldKey = (typeof SERVER_OWNED_MATTER_FIELD_KEYS)[number];

const SERVER_OWNED_SET = new Set<string>(SERVER_OWNED_MATTER_FIELD_KEYS);

export interface PartnerCostSignOffRecord {
  byId: string;
  byName: string;
  at: string;
  note: string;
  signedOffEstimateGbp: number | null;
}

export function stripServerOwnedFieldValues(
  incoming: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!incoming) return {};
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!SERVER_OWNED_SET.has(k)) cleaned[k] = v;
  }
  return cleaned;
}
