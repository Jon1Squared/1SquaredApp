import { describe, expect, it } from 'vitest';
import { buildDemoData } from '@/seed/demo';
import { buildSeedLists } from '@/seed/lists';
import { repairOrphanTaxonomyIds } from './store';

describe('repairOrphanTaxonomyIds (R217)', () => {
  it('preserves a matter practiceAreaId when it is an admin-added value in parsed.values', () => {
    const demo = buildDemoData();
    const parsed = structuredClone({
      matters: demo.matters,
      enquiries: demo.enquiries,
      quotes: demo.quotes,
    });
    const seedLists = buildSeedLists();
    const adminAddedPracticeAreaId = 'practice_area.maritime_shipping_custom';
    const validIds = new Set<string>([
      ...seedLists.values.map((v) => v.id),
      adminAddedPracticeAreaId,
    ]);

    parsed.matters[0]!.practiceAreaId = adminAddedPracticeAreaId;

    const result = repairOrphanTaxonomyIds(parsed, demo, validIds);
    expect(result.repairedCount).toBe(0);
    expect(parsed.matters[0]!.practiceAreaId).toBe(adminAddedPracticeAreaId);
  });

  it('replaces a truly orphaned taxonomy ID (in neither seed nor parsed.values) with the matching seed ID', () => {
    const demo = buildDemoData();
    const parsed = structuredClone({
      matters: demo.matters,
      enquiries: demo.enquiries,
      quotes: demo.quotes,
    });
    const seedLists = buildSeedLists();
    const validIds = new Set<string>(seedLists.values.map((v) => v.id));

    parsed.matters[0]!.practiceAreaId = 'practice_area.legacy_orphan_not_in_store';
    parsed.enquiries[0]!.workTypeSubcategoryId = 'work_type_subcategory.legacy_orphan';

    const result = repairOrphanTaxonomyIds(parsed, demo, validIds);
    expect(result.repairedCount).toBe(2);
    expect(parsed.matters[0]!.practiceAreaId).toBe(demo.matters[0]!.practiceAreaId);
    expect(parsed.enquiries[0]!.workTypeSubcategoryId).toBe(
      demo.enquiries[0]!.workTypeSubcategoryId,
    );
  });

  it('changes nothing when every taxonomy ID is valid', () => {
    const demo = buildDemoData();
    const parsed = structuredClone({
      matters: demo.matters,
      enquiries: demo.enquiries,
      quotes: demo.quotes,
    });
    const beforeSnapshot = structuredClone(parsed);
    const seedLists = buildSeedLists();
    const validIds = new Set<string>(seedLists.values.map((v) => v.id));

    const result = repairOrphanTaxonomyIds(parsed, demo, validIds);
    expect(result.repairedCount).toBe(0);
    expect(parsed).toEqual(beforeSnapshot);
  });
});
