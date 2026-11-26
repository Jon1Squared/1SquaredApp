import { describe, expect, it } from 'vitest';
import {
  isMatterCmiIncompleteStatus,
  resolveMatterStatusPill,
  resolveMatterStatusSystemKey,
} from '../matterStatusDisplay';
import type { ChoiceValue } from '../types';

function makeStatusValue(
  id: string,
  label: string,
  systemKey?: string,
): ChoiceValue {
  return {
    id,
    listKey: 'matter_status',
    label,
    ...(systemKey !== undefined ? { systemKey } : {}),
    sortOrder: 1,
    active: true,
  };
}

describe('R814: matterStatusDisplay resolves strictly via systemKey without hard-coded seed ID fallbacks', () => {
  it('resolves non-seed custom tenant status IDs via systemKey', () => {
    const customValues = [
      makeStatusValue('tenant_status.prospect', 'Enquiry Stage', 'prospective'),
      makeStatusValue('tenant_status.cmi_hold', 'Awaiting CMI', 'cmi_incomplete'),
      makeStatusValue('tenant_status.live', 'Live Matter', 'active'),
      makeStatusValue('tenant_status.paused', 'On Hold', 'on_hold'),
      makeStatusValue('tenant_status.done', 'Finished', 'completed'),
      makeStatusValue('tenant_status.shut', 'Closed', 'closed'),
      makeStatusValue('tenant_status.filed', 'Archived', 'archived'),
      makeStatusValue('tenant_status.dead', 'Aborted', 'aborted'),
    ];

    expect(resolveMatterStatusSystemKey('tenant_status.prospect', customValues)).toBe('prospective');
    expect(resolveMatterStatusSystemKey('tenant_status.cmi_hold', customValues)).toBe('cmi_incomplete');
    expect(resolveMatterStatusSystemKey('tenant_status.live', customValues)).toBe('active');
    expect(resolveMatterStatusSystemKey('tenant_status.paused', customValues)).toBe('on_hold');
    expect(resolveMatterStatusSystemKey('tenant_status.done', customValues)).toBe('completed');
    expect(resolveMatterStatusSystemKey('tenant_status.shut', customValues)).toBe('closed');
    expect(resolveMatterStatusSystemKey('tenant_status.filed', customValues)).toBe('archived');
    expect(resolveMatterStatusSystemKey('tenant_status.dead', customValues)).toBe('aborted');

    expect(
      isMatterCmiIncompleteStatus(
        {
          matterStatusId: 'tenant_status.live',
          amlStatus: 'Pending',
          fieldValues: {},
          isPmsImport: false,
        },
        customValues,
      ),
    ).toBe(true);

    expect(
      isMatterCmiIncompleteStatus(
        {
          matterStatusId: 'tenant_status.live',
          amlStatus: 'Verified',
          fieldValues: { matterOpeningGate: { openedViaGate: true } },
          isPmsImport: false,
        },
        customValues,
      ),
    ).toBe(false);

    expect(
      resolveMatterStatusPill(
        {
          matterStatusId: 'tenant_status.live',
          amlStatus: 'Verified',
          conflictCheckStatus: 'Cleared',
          fieldValues: { matterOpeningGate: { openedViaGate: true } },
          isPmsImport: false,
        },
        customValues,
      ),
    ).toMatchObject({ label: 'Open', tone: 'positive', isCmiIncomplete: false });
  });

  it('returns null for seed matter_status.* IDs when values list has no matching entry with systemKey', () => {
    const seedIds = [
      'matter_status.prospective_enquiry',
      'matter_status.prospective',
      'matter_status.cmi_incomplete',
      'matter_status.active',
      'matter_status.on_hold',
      'matter_status.completed',
      'matter_status.closed',
      'matter_status.archived',
      'matter_status.aborted_lost',
    ];

    for (const seedId of seedIds) {
      expect(resolveMatterStatusSystemKey(seedId, [])).toBeNull();
      expect(
        resolveMatterStatusSystemKey(seedId, [
          makeStatusValue(seedId, 'No System Key'),
        ]),
      ).toBeNull();
    }

    expect(
      isMatterCmiIncompleteStatus(
        {
          matterStatusId: 'matter_status.active',
          amlStatus: 'Pending',
          fieldValues: {},
          isPmsImport: false,
        },
        [],
      ),
    ).toBe(false);
    expect(
      isMatterCmiIncompleteStatus(
        {
          matterStatusId: 'matter_status.cmi_incomplete',
          amlStatus: 'Pending',
          fieldValues: {},
          isPmsImport: false,
        },
        [],
      ),
    ).toBe(false);
  });

  it('R816 / R819: respects server-derived isLegacyCmiIncomplete when present on redacted rows', () => {
    const customValues = [
      makeStatusValue('tenant_status.live', 'Live Matter', 'active'),
    ];

    expect(
      isMatterCmiIncompleteStatus(
        {
          matterStatusId: 'tenant_status.live',
          amlStatus: 'Not available to you',
          fieldValues: {},
          isPmsImport: false,
          isLegacyCmiIncomplete: true,
        },
        customValues,
      ),
    ).toBe(true);

    expect(
      resolveMatterStatusPill(
        {
          matterStatusId: 'tenant_status.live',
          amlStatus: 'Not available to you',
          conflictCheckStatus: 'Cleared',
          fieldValues: {},
          isPmsImport: false,
          isLegacyCmiIncomplete: true,
        },
        customValues,
      ),
    ).toMatchObject({
      label: 'CMI incomplete',
      tone: 'warning',
      isCmiIncomplete: true,
    });

    expect(
      resolveMatterStatusPill(
        {
          matterStatusId: 'tenant_status.live',
          amlStatus: 'Pending',
          conflictCheckStatus: 'Cleared',
          fieldValues: {},
          isPmsImport: false,
          isLegacyCmiIncomplete: false,
        },
        customValues,
      ),
    ).toMatchObject({
      label: 'Open',
      tone: 'positive',
      isCmiIncomplete: false,
    });
  });
});
