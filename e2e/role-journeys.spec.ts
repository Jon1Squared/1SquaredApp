import { expect, test, type Page } from '@playwright/test';
import { createDefaultRbacConfig } from '../core/src/domain/rbac/registry';
import { resolveTenantFromVerifiedToken } from '../core/src/tenancy/index';
import { TenantMatterRepository } from '../core/src/tenancy/matterRepository';
import { getGlobalTenantPostgresPoolManager } from '../core/src/tenancy/postgresPoolManager';
import {
  getLeftRailVisibility,
  type LeftRailVisibility,
} from '../src/domain/homeConfig';
import type { Matter } from '../src/domain/types';
import { ROLE_SEED_ACTORS, storageStatePathFor } from './global-setup';

/**
 * Browser-level role journey smoke tests (Slice S0-27).
 *
 * Covers the 8 roles that have seeded holders in `data/seed-not-a-law-firm.json`:
 * - `fee_earner` (P-000002 — Dafydd Evans)
 * - `partner` (P-000001 — Rhian Morgan)
 * - `legal_secretary` (P-000010 — Nia Edwards)
 * - `enquiries_coordinator` (P-000042 — Lowri Ellis)
 * - `finance` (P-000009 — Gethin Powell)
 * - `risk_compliance` (P-000003 — Bethan Rees)
 * - `managing_partner` (P-000038 — Gethin Lloyd)
 * - `admin` (P-000004 — Huw Pritchard, `mfaVerified: true`)
 *
 * Note: `supervisor` and `intake` have no seeded holder in
 * `data/seed-not-a-law-firm.json` and are therefore omitted here.
 */

const EXPECTED_ROLE_RAIL_VISIBILITY: Readonly<
  Record<string, LeftRailVisibility>
> = {
  fee_earner: {
    home: true,
    enquiries: true,
    tasks: true,
    keyDates: true,
    registers: true,
    matters: true,
    contacts: true,
    finance: false,
    risk: false,
    admin: false,
  },
  partner: {
    home: true,
    enquiries: true,
    tasks: true,
    keyDates: true,
    registers: true,
    matters: true,
    contacts: true,
    finance: true,
    risk: false,
    admin: true,
  },
  legal_secretary: {
    home: true,
    enquiries: true,
    tasks: true,
    keyDates: true,
    registers: true,
    matters: true,
    contacts: true,
    finance: false,
    risk: false,
    admin: false,
  },
  enquiries_coordinator: {
    home: true,
    enquiries: true,
    tasks: true,
    keyDates: false,
    registers: false,
    matters: false,
    contacts: true,
    finance: false,
    risk: false,
    admin: false,
  },
  finance: {
    home: true,
    enquiries: false,
    tasks: true,
    keyDates: false,
    registers: true,
    matters: true,
    contacts: true,
    finance: true,
    risk: false,
    admin: false,
  },
  risk_compliance: {
    home: true,
    enquiries: true,
    tasks: true,
    keyDates: true,
    registers: true,
    matters: true,
    contacts: true,
    finance: false,
    risk: true,
    admin: true,
  },
  managing_partner: {
    home: true,
    enquiries: true,
    tasks: true,
    keyDates: true,
    registers: true,
    matters: true,
    contacts: true,
    finance: true,
    risk: true,
    admin: true,
  },
  admin: {
    home: true,
    enquiries: true,
    tasks: true,
    keyDates: true,
    registers: true,
    matters: true,
    contacts: true,
    finance: true,
    risk: true,
    admin: true,
  },
};

const RAIL_LINK_SPECS: readonly {
  readonly href: string;
  readonly label: string;
  readonly visibilityKey: keyof LeftRailVisibility | 'docs';
}[] = [
  { href: '/', label: 'Home', visibilityKey: 'home' },
  {
    href: '/enquiries',
    label: 'Enquiries & Quotes',
    visibilityKey: 'enquiries',
  },
  { href: '/tasks', label: 'Tasks', visibilityKey: 'tasks' },
  { href: '/key-dates', label: 'Key dates', visibilityKey: 'keyDates' },
  { href: '/registers', label: 'Registers', visibilityKey: 'registers' },
  { href: '/matters', label: 'Matters', visibilityKey: 'matters' },
  { href: '/people', label: 'People', visibilityKey: 'contacts' },
  {
    href: '/organisations',
    label: 'Organisations',
    visibilityKey: 'contacts',
  },
  { href: '/?view=finance', label: 'Finance', visibilityKey: 'finance' },
  {
    href: '/?view=risk_compliance',
    label: 'Risk and compliance',
    visibilityKey: 'risk',
  },
  { href: '/admin/lists', label: 'Admin', visibilityKey: 'admin' },
  { href: '/docs', label: 'Help & documentation', visibilityKey: 'docs' },
];

async function assertLeftRailMatchesRole(
  page: Page,
  roleKey: string,
  userRoles: string[],
): Promise<void> {
  const computedVisibility = getLeftRailVisibility(roleKey, userRoles, {
    tenantId: 'not-a-law-firm',
    config: { rbac: createDefaultRbacConfig() },
  });
  const expectedVisibility = EXPECTED_ROLE_RAIL_VISIBILITY[roleKey];
  expect(computedVisibility).toEqual(expectedVisibility);

  const railNav = page.locator('aside.left-rail nav.rail-nav');
  await expect(railNav).toBeVisible();

  for (const item of RAIL_LINK_SPECS) {
    const shouldBeVisible =
      item.visibilityKey === 'docs'
        ? true
        : computedVisibility[item.visibilityKey];
    const linkLocator = railNav.locator(`a.rail-item[href="${item.href}"]`);
    if (shouldBeVisible) {
      await expect(
        linkLocator,
        `Expected left-rail item "${item.label}" (${item.href}) to be visible for ${roleKey}`,
      ).toHaveCount(1);
    } else {
      await expect(
        linkLocator,
        `Expected left-rail item "${item.label}" (${item.href}) to be hidden for ${roleKey}`,
      ).toHaveCount(0);
    }
  }
}

function attachPageErrorCollector(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });
  return errors;
}

function findActor(stateKey: string) {
  const actor = ROLE_SEED_ACTORS.find((a) => a.stateKey === stateKey);
  if (!actor) {
    throw new Error(`Missing ROLE_SEED_ACTORS entry for ${stateKey}`);
  }
  return actor;
}

test.describe('S0-27: Role journey smoke tests (8 seeded roles)', () => {
  test.describe('1. Fee earner (P-000002 — Dafydd Evans)', () => {
    const actor = findActor('fee_earner');
    test.use({ storageState: storageStatePathFor(actor.stateKey) });

    test('loads Home, matches left rail visibility, opens a matter workspace, and is refused /admin', async ({
      page,
    }) => {
      const pageErrors = attachPageErrorCollector(page);

      // 1. Home loads without errors, with the right Home role
      await page.goto('/');
      await expect(page.locator('.hero-greeting')).toContainText(
        actor.firstName,
      );
      await expect(page.locator('header.top-bar #viewing-as-role-select')).toHaveValue(
        'fee_earner',
      );

      // 2. Left menu shows exactly what getLeftRailVisibility gives that role
      await assertLeftRailMatchesRole(page, actor.roleKey, actor.mappedRoles);

      // 3. Main action: open Matters list and click into the seeded commercial lease matter
      await page.locator('aside.left-rail a.rail-item[href="/matters"]').click();
      await expect(page).toHaveURL(/\/matters$/);
      const matterLink = page.locator('a[href="/matters/M-000001"]').first();
      await expect(matterLink).toBeVisible();
      await matterLink.click();
      await expect(page).toHaveURL(/\/matters\/M-\d+/);
      await expect(page.locator('.main-area')).toContainText(
        'Grant of commercial lease',
      );

      // 4. Refused page: fee earner cannot reach /admin (redirected to /)
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/$/);
      expect(pageErrors).toEqual([]);
    });
  });

  test.describe('2. Partner (P-000001 — Rhian Morgan)', () => {
    const actor = findActor('partner');
    test.use({ storageState: storageStatePathFor(actor.stateKey) });

    test('loads Home with partner panels, matches left rail visibility, opens Matters, and is refused /admin without MFA', async ({
      page,
    }) => {
      const pageErrors = attachPageErrorCollector(page);

      // 1. Home loads without errors, with the right Home role
      await page.goto('/');
      await expect(page.locator('.hero-greeting')).toContainText(
        actor.firstName,
      );
      await expect(page.locator('header.top-bar #viewing-as-role-select')).toHaveValue(
        'partner',
      );
      await expect(
        page.locator('[data-panel-id="matters_needing_partner_attention"]'),
      ).toBeVisible();

      // 2. Left menu shows exactly what getLeftRailVisibility gives that role
      await assertLeftRailMatchesRole(page, actor.roleKey, actor.mappedRoles);

      // 3. Main action: open Key dates diary workspace
      await page
        .locator('aside.left-rail a.rail-item[href="/key-dates"]')
        .click();
      await expect(page).toHaveURL(/\/key-dates$/);
      await expect(page.locator('.main-area')).toContainText(/Key [Dd]ates/);

      // 4. Refused/hidden: Risk & compliance is hidden in left rail, and /admin redirects to / when mfaVerified is false
      await expect(
        page.locator('aside.left-rail a.rail-item[href="/?view=risk_compliance"]'),
      ).toHaveCount(0);
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/$/);
      expect(pageErrors).toEqual([]);
    });
  });

  test.describe('3. Legal secretary (P-000010 — Nia Edwards)', () => {
    const actor = findActor('legal_secretary');
    test.use({ storageState: storageStatePathFor(actor.stateKey) });

    test('loads Home, matches left rail visibility, opens Tasks workspace, and is refused /admin', async ({
      page,
    }) => {
      const pageErrors = attachPageErrorCollector(page);

      // 1. Home loads without errors, with the right Home role
      await page.goto('/');
      await expect(page.locator('.hero-greeting')).toContainText(
        actor.firstName,
      );
      await expect(page.locator('header.top-bar #viewing-as-role-select')).toHaveValue(
        'legal_secretary',
      );

      // 2. Left menu shows exactly what getLeftRailVisibility gives that role
      await assertLeftRailMatchesRole(page, actor.roleKey, actor.mappedRoles);

      // 3. Main action: open Tasks workspace and view tasks
      await page.locator('aside.left-rail a.rail-item[href="/tasks"]').click();
      await expect(page).toHaveURL(/\/tasks$/);
      await expect(page.locator('.main-area')).toContainText(/Tasks/);

      // 4. Refused page: legal secretary cannot reach /admin (redirected to /)
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/$/);
      expect(pageErrors).toEqual([]);
    });
  });

  test.describe('4. Enquiries coordinator (P-000042 — Lowri Ellis)', () => {
    // Note: this journey saves a personal draft enquiry for P-000042 in the shared runtime store; other journeys must not rely on enquiry counts or the drafts list.
    const actor = findActor('enquiries_coordinator');
    test.use({ storageState: storageStatePathFor(actor.stateKey) });

    test('loads Home, matches left rail visibility, saves a draft enquiry end to end, and is refused /admin', async ({
      page,
    }) => {
      const pageErrors = attachPageErrorCollector(page);

      // 1. Home loads without errors, with the right Home role
      await page.goto('/');
      await expect(page.locator('.hero-greeting')).toContainText(
        actor.firstName,
      );
      await expect(page.locator('header.top-bar #viewing-as-role-select')).toHaveValue(
        'enquiries_coordinator',
      );

      // 2. Left menu shows exactly what getLeftRailVisibility gives that role (Matters, Key dates, Admin hidden)
      await assertLeftRailMatchesRole(page, actor.roleKey, actor.mappedRoles);

      // 3. Main action: open /enquiries/new and save a draft enquiry
      await page.goto('/enquiries/new');
      await expect(page.locator('h1.new-enquiry-title')).toHaveText(
        'New enquiry',
      );
      await page.locator('#enq-first-name').fill('Eleri');
      await page.locator('#enq-last-name').fill('Vaughan');
      await page
        .getByRole('button', { name: 'Save as draft' })
        .first()
        .click();
      await expect(page).toHaveURL(/\/enquiries\/ENQ-\d+/);
      await expect(page.locator('h1.new-enquiry-title')).toContainText(
        'Eleri Vaughan',
      );
      await expect(page.locator('.new-enquiry-header')).toContainText('Draft');

      // 4. Refused/hidden: Matters is hidden from left rail, and /admin redirects to /
      await expect(
        page.locator('aside.left-rail a.rail-item[href="/matters"]'),
      ).toHaveCount(0);
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/$/);
      expect(pageErrors).toEqual([]);
    });
  });

  test.describe('5. Finance (P-000009 — Gethin Powell)', () => {
    const actor = findActor('finance');
    test.use({ storageState: storageStatePathFor(actor.stateKey) });

    test('loads Home, matches left rail visibility, opens Finance workspace, and is refused /admin', async ({
      page,
    }) => {
      const pageErrors = attachPageErrorCollector(page);

      // 1. Home loads without errors, with the right Home role
      await page.goto('/');
      await expect(page.locator('.hero-greeting')).toContainText(
        actor.firstName,
      );
      await expect(page.locator('header.top-bar #viewing-as-role-select')).toHaveValue(
        'finance',
      );

      // 2. Left menu shows exactly what getLeftRailVisibility gives that role (Enquiries, Key dates, Risk, Admin hidden)
      await assertLeftRailMatchesRole(page, actor.roleKey, actor.mappedRoles);

      // 3. Main action: open Finance view via the left rail and verify Finance panels render
      await page
        .locator('aside.left-rail a.rail-item[href="/?view=finance"]')
        .click();
      await expect(
        page.locator('[data-panel-id="aged_debt_by_age_band"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-panel-id="overdue_invoices_worklist"]'),
      ).toBeVisible();

      // 4. Refused/hidden: Enquiries & Quotes is hidden in left rail, and /admin redirects to /
      await expect(
        page.locator('aside.left-rail a.rail-item[href="/enquiries"]'),
      ).toHaveCount(0);
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/$/);
      expect(pageErrors).toEqual([]);
    });
  });

  test.describe('6. Risk and compliance (P-000003 — Bethan Rees)', () => {
    const actor = findActor('risk_compliance');
    test.use({ storageState: storageStatePathFor(actor.stateKey) });

    test('loads Home, matches left rail visibility, opens Risk and compliance workspace, and is refused /admin without MFA', async ({
      page,
    }) => {
      const pageErrors = attachPageErrorCollector(page);

      // 1. Home loads without errors, with the right Home role
      await page.goto('/');
      await expect(page.locator('.hero-greeting')).toContainText(
        actor.firstName,
      );
      await expect(page.locator('header.top-bar #viewing-as-role-select')).toHaveValue(
        'risk_compliance',
      );

      // 2. Left menu shows exactly what getLeftRailVisibility gives that role
      await assertLeftRailMatchesRole(page, actor.roleKey, actor.mappedRoles);

      // 3. Main action: open Risk and compliance view and verify AML/conflict panels render
      await page
        .locator('aside.left-rail a.rail-item[href="/?view=risk_compliance"]')
        .click();
      await expect(
        page.locator('[data-panel-id="aml_and_cdd_queue"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-panel-id="conflict_checks_awaiting_decision"]'),
      ).toBeVisible();

      // 4. Refused/hidden: Finance is hidden in left rail under risk_compliance, and /admin redirects to / when mfaVerified is false
      await expect(
        page.locator('aside.left-rail a.rail-item[href="/?view=finance"]'),
      ).toHaveCount(0);
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/$/);
      expect(pageErrors).toEqual([]);
    });
  });

  test.describe('7. Managing partner (P-000038 — Gethin Lloyd)', () => {
    const actor = findActor('managing_partner');
    test.use({ storageState: storageStatePathFor(actor.stateKey) });

    test('loads Home with executive panels, matches left rail visibility, opens Organisations, and is refused /admin without MFA', async ({
      page,
    }) => {
      const pageErrors = attachPageErrorCollector(page);

      // 1. Home loads without errors, with the right Home role
      await page.goto('/');
      await expect(page.locator('.hero-greeting')).toContainText(
        actor.firstName,
      );
      await expect(page.locator('header.top-bar #viewing-as-role-select')).toHaveValue(
        'managing_partner',
      );
      await expect(
        page.locator('[data-panel-id="firm_financial_pulse"]'),
      ).toBeVisible();

      // 2. Left menu shows exactly what getLeftRailVisibility gives that role
      await assertLeftRailMatchesRole(page, actor.roleKey, actor.mappedRoles);

      // 3. Main action: open Organisations directory
      await page
        .locator('aside.left-rail a.rail-item[href="/organisations"]')
        .click();
      await expect(page).toHaveURL(/\/organisations$/);
      await expect(page.locator('.main-area')).toContainText(/Organisations/);

      // 4. Refused page: /admin redirects to / when mfaVerified is false
      await page.goto('/admin');
      await expect(page).toHaveURL(/\/$/);
      expect(pageErrors).toEqual([]);
    });
  });

  test.describe('8. Admin (P-000004 — Huw Pritchard)', () => {
    const actor = findActor('admin');

    test('with mfaVerified: true, loads Home, matches left rail visibility, and opens Admin workspace', async ({
      browser,
    }) => {
      const context = await browser.newContext({
        storageState: storageStatePathFor('admin'),
      });
      const page = await context.newPage();
      const pageErrors = attachPageErrorCollector(page);

      try {
        // 1. Home loads without errors, with the right Home role
        await page.goto('/');
        await expect(page.locator('.hero-greeting')).toContainText(
          actor.firstName,
        );
        await expect(page.locator('header.top-bar #viewing-as-role-select')).toHaveValue(
          'admin',
        );

        // 2. Left menu shows exactly what getLeftRailVisibility gives that role
        await assertLeftRailMatchesRole(
          page,
          actor.roleKey,
          actor.mappedRoles,
        );

        // 3. Main action: open Admin via left rail and verify Admin sections load
        await page
          .locator('aside.left-rail a.rail-item[href="/admin/lists"]')
          .click();
        await expect(page).toHaveURL(/\/admin\/lists$/);
        await expect(page.locator('.main-area')).toContainText(/Admin/i);
        expect(pageErrors).toEqual([]);
      } finally {
        await context.close();
      }
    });

    test('with mfaVerified: false, Admin is refused /admin and redirected to /', async ({
      browser,
    }) => {
      // 4. Refused page: admin is refused /admin when mfaVerified is false
      const context = await browser.newContext({
        storageState: storageStatePathFor('admin_no_mfa'),
      });
      const page = await context.newPage();
      const pageErrors = attachPageErrorCollector(page);

      try {
        await page.goto('/admin/lists');
        await expect(page).toHaveURL(/\/$/);
        expect(pageErrors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  });
});

test.describe.serial('R657: Core intake-to-matter journeys (seeded demo dataset)', () => {
  let createdEnquiryId = '';

  test('1. Enquiries coordinator creates an enquiry and sends it to a team', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: storageStatePathFor('enquiries_coordinator'),
    });
    const page = await context.newPage();
    const pageErrors = attachPageErrorCollector(page);

    try {
      await page.goto('/enquiries/new');
      await expect(page.locator('#enq-privacy-notice')).toBeVisible();
      await expect(page.locator('#enq-privacy-notice')).toHaveValue('no');

      // R656 / R657: Fill every field while leaving Privacy notice given at "No",
      // press Send to Team, and assert the inline error blocks submission and creation.
      await page.locator('#enq-first-name').fill('Aelwen');
      await page.locator('#enq-last-name').fill('Meredith');
      await page.locator('#enq-phone').fill('029 2010 7788');
      await page
        .locator('#enq-practice-area')
        .selectOption('work_type.real_estate_and_property');
      await page
        .locator('#enq-subcat')
        .selectOption('work_type.real_estate_and_property_commercial_property');
      await page
        .locator('#enq-summary')
        .fill('Commercial lease review for Bridgend retail unit');
      await page.locator('#enq-other-parties').fill('Ogmore Fabrication Group Ltd');
      await page
        .locator('#enq-notes')
        .fill('Caller requested lease terms review ahead of heads of terms.');

      await page.getByRole('button', { name: 'Send to Team' }).first().click();

      const privacyFieldError = page.locator('.field-error', {
        hasText: 'Please confirm the privacy notice was read or sent to the caller.',
      });
      await expect(privacyFieldError).toBeVisible();
      await expect(page).toHaveURL(/\/enquiries\/new$/);

      const verifyPage = await context.newPage();
      try {
        await verifyPage.goto('/enquiries');
        await verifyPage.getByRole('tab', { name: /^All open/ }).click();
        await expect(verifyPage.locator('.main-area')).not.toContainText('Aelwen Meredith');
        await verifyPage.getByRole('tab', { name: /^My drafts/ }).click();
        await expect(verifyPage.locator('.main-area')).not.toContainText('Aelwen Meredith');
      } finally {
        await verifyPage.close();
      }

      await page.locator('#enq-privacy-notice').selectOption('yes');
      await page.getByRole('button', { name: 'Send to Team' }).first().click();

      await expect(page.locator('[data-testid="enquiry-error-summary"]')).toHaveCount(0);
      await expect(page).toHaveURL(/\/enquiries\/(ENQ-\d+)$/, { timeout: 20_000 });
      const match = /\/enquiries\/(ENQ-\d+)$/.exec(page.url());
      expect(match?.[1]).toBeTruthy();
      createdEnquiryId = match![1]!;

      await expect(page.locator('.new-enquiry-badge--warn')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Convert to matter' }).first(),
      ).toBeVisible();
      await expect(page.locator('.main-area')).toContainText(
        'Routes to team: Real Estate & Property',
      );
      await expect(page.locator('.main-area')).toContainText(
        'Contact new enquiry: Aelwen Meredith',
      );
      await expect(page.locator('.main-area')).not.toContainText(
        'no active fallback intake team',
      );

      await page.goto('/enquiries');
      await page.getByRole('tab', { name: /^All open/ }).click();
      const enqRow = page
        .locator('tr', { has: page.locator(`a[href="/enquiries/${createdEnquiryId}"]`) })
        .first();
      await expect(enqRow).toBeVisible();
      await expect(enqRow).toContainText('New');
      await expect(enqRow).toContainText('Real Estate & Property');
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('2. Fee earner converts enquiry, runs conflict search, and opens a matter', async ({
    browser,
  }) => {
    expect(createdEnquiryId).toMatch(/^ENQ-\d+$/);

    const context = await browser.newContext({
      storageState: storageStatePathFor('fee_earner'),
    });
    const page = await context.newPage();
    const pageErrors = attachPageErrorCollector(page);

    try {
      await page.goto(`/enquiries/${createdEnquiryId}`);
      await expect(page.locator('.main-area')).toContainText(createdEnquiryId);

      await page.getByRole('button', { name: 'Convert to matter' }).first().click();
      await expect(
        page.getByRole('heading', { name: `Convert ${createdEnquiryId} to a matter` }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: /Continue to pre-filled New Matter form/ })
        .click();

      await expect(page).toHaveURL(/\/matters\/new\?/, { timeout: 20_000 });

      const conflictSearchSection = page.getByRole('region', {
        name: '5 · CONFLICT SEARCH',
      });
      const conflictMaxBtn = conflictSearchSection.getByRole('button', {
        name: 'Maximise',
      });
      if (await conflictMaxBtn.isVisible()) {
        await conflictMaxBtn.click();
      }

      await page.getByRole('button', { name: 'Run conflict search' }).first().click();
      await expect(conflictSearchSection).toContainText('Reviewed', {
        timeout: 15_000,
      });

      const outcomeSection = page.getByRole('region', {
        name: '6 · OUTCOME AND DECLARATION',
      });
      const outcomeMaxBtn = outcomeSection.getByRole('button', {
        name: 'Maximise',
      });
      if (await outcomeMaxBtn.isVisible()) {
        await outcomeMaxBtn.click();
      }

      await expect(outcomeSection).toContainText(
        /Cleared by fee earner|Referred to risk for review/,
        { timeout: 15_000 },
      );

      await page
        .getByLabel(/I confirm the parties listed are complete/)
        .check();

      const submitBtn = page.getByRole('button', { name: 'Submit', exact: true });
      await expect(submitBtn).toBeEnabled();
      await submitBtn.click();

      await expect(page.locator('[data-testid="matter-error-summary"]')).toHaveCount(0);
      await expect(page).toHaveURL(/\/matters\/M-\d+$/, { timeout: 25_000 });
      await expect(page.locator('.main-area')).toContainText(
        'Commercial lease review for Bridgend retail unit',
      );
      await expect(page.locator('.main-area')).toContainText(/\b[A-Z]{3}\d{3}-\d{4}\b/);
      await expect(
        page.locator('[data-testid="matter-header-new-undertaking"]'),
      ).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe('S1-02b C2: Server-backed duplicate and conflict previews during intake', () => {
  test('1. Enquiries coordinator (Lowri) sees duplicate warning on /people/new', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: storageStatePathFor('enquiries_coordinator'),
    });
    const page = await context.newPage();
    const pageErrors = attachPageErrorCollector(page);

    try {
      await page.goto('/people/new');
      await expect(page.locator('#p-first')).toBeVisible();

      await page.locator('#p-first').fill('Gareth');
      await page.locator('#p-surname').fill('Hughes');
      await page.locator('#p-postcode').fill('CF10 3BX');

      const dupBanner = page.locator('[role="alert"]', {
        hasText: 'Possible duplicate detected',
      });
      await expect(dupBanner).toBeVisible({ timeout: 10_000 });
      await expect(dupBanner).toContainText('Gareth Hughes');
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('2. Enquiries coordinator sees preliminary conflict hit on /enquiries/new', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: storageStatePathFor('enquiries_coordinator'),
    });
    const page = await context.newPage();
    const pageErrors = attachPageErrorCollector(page);

    try {
      await page.goto('/enquiries/new');
      await expect(page.locator('#enq-first-name')).toBeVisible();

      await page.locator('#enq-first-name').fill('Iwan');
      await page.locator('#enq-last-name').fill('Phillips');
      await page.locator('#enq-other-parties').fill('Coastline Outdoor Ltd');
      await page.locator('#enq-other-parties').blur();

      const mainArea = page.locator('.main-area');
      await expect(mainArea).toContainText('Possible conflicts', {
        timeout: 15_000,
      });
      await expect(mainArea).toContainText('PEN001-0004');
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe('S1-02b WP1b picker journeys', () => {
  test('1. R699 minor person client can pick unlinked adult instructing contact on /matters/new', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: storageStatePathFor('fee_earner'),
    });
    const page = await context.newPage();
    const pageErrors = attachPageErrorCollector(page);

    try {
      await page.goto('/people/new');
      await expect(page.locator('#p-first')).toBeVisible();
      await page.locator('#p-first').fill('Alys');
      await page.locator('#p-surname').fill('Bryn-Minor');
      await page.locator('#p-dob').fill('2015-01-01');
      await page.locator('#p-email').fill('alys.minor@example.test');
      await page.getByRole('button', { name: 'Create person', exact: true }).click();
      await page.waitForURL(/\/people\/P-/, { timeout: 15_000 });
      const minorId = new URL(page.url()).pathname.split('/').pop();
      expect(minorId).toMatch(/^P-/);

      await page.goto(`/matters/new?clientId=${minorId}`);
      await expect(page.locator('#nm-instructing')).toBeVisible({ timeout: 15_000 });

      const instructingSearch = page.getByRole('searchbox', {
        name: 'Search instructing contacts',
      });
      await expect(instructingSearch).toBeVisible();
      const instructingSelect = page.locator('#nm-instructing');

      // Minor client must never appear as an instructing-contact option even when searched
      await instructingSearch.fill('Bryn-Minor');
      await page.waitForTimeout(450);
      await expect(page.getByText('Searching…')).toHaveCount(0, { timeout: 5_000 });
      await expect(
        instructingSelect.locator(`option[value="${minorId}"]`),
      ).toHaveCount(0);

      await instructingSearch.fill('Mared Hughes');
      await expect(
        instructingSelect.locator('option[value="P-000013"]'),
      ).toHaveCount(1, { timeout: 10_000 });
      await instructingSelect.selectOption('P-000013');
      await expect(instructingSelect).toHaveValue('P-000013');

      // Save the draft matter and verify it persists with the chosen instructing contact
      const draftTitle = 'R699 Minor Client Instructing Draft';
      await page.locator('#nm-description').fill(draftTitle);
      await page.locator('#nm-department').selectOption({ index: 1 });
      await page.locator('#nm-worktype').selectOption({ index: 1 });
      await page.getByRole('button', { name: 'Save draft', exact: true }).click();
      await expect(page.locator('[data-testid="matter-error-summary"]')).toHaveCount(0);
      await expect(page.locator('.toast-pill')).toContainText('Draft saved', {
        timeout: 15_000,
      });

      await page.goto(`/matters?q=${encodeURIComponent(draftTitle)}`);
      const savedDraftLink = page
        .locator('a[href^="/matters/M-"]', { hasText: draftTitle })
        .first();
      await expect(savedDraftLink).toBeVisible({ timeout: 15_000 });
      await savedDraftLink.click();
      await expect(page).toHaveURL(/\/matters\/M-\d+/, { timeout: 15_000 });
      await expect(page.locator('#nm-instructing')).toHaveValue('P-000013', {
        timeout: 15_000,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('2. R701 + Add party modal searches directory and links existing organisation O-000015', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: storageStatePathFor('fee_earner'),
    });
    const page = await context.newPage();
    const pageErrors = attachPageErrorCollector(page);

    try {
      await page.goto('/matters/new');
      const partiesCardHeading = page.locator('#card-2-heading');
      await expect(partiesCardHeading).toBeVisible({ timeout: 15_000 });

      const addPartyBtn = page.getByRole('button', { name: 'Add party' });
      if (!(await addPartyBtn.isVisible())) {
        await partiesCardHeading.click();
      }
      await expect(addPartyBtn).toBeVisible();
      await addPartyBtn.click();

      const orgSearch = page.getByRole('searchbox', {
        name: 'Search existing organisations',
      });
      await expect(orgSearch).toBeVisible();
      await orgSearch.fill('Coastline Outdoor');

      const existingOrgSelect = page.locator('#nm-party-existing-search');
      await expect(
        existingOrgSelect.locator('option[value="O-000015"]'),
      ).toHaveCount(1, { timeout: 10_000 });
      await existingOrgSelect.selectOption('O-000015');

      await page.locator('#nm-party-relationship').selectOption('OP');
      await page
        .getByRole('button', { name: /Add Coastline Outdoor Ltd as party/i })
        .click();

      const partiesCard = page.locator('section[aria-labelledby="card-2-heading"]');
      await expect(partiesCard).toContainText('Coastline Outdoor Ltd');
      await expect(
        partiesCard.getByRole('button', { name: /Include related entities/i }),
      ).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('3. Suggestion 4: Fee earner sees redacted Restricted matter conflict hit on /enquiries/new without leaking confidential title or number', async ({
    browser,
  }) => {
    process.env.PLATFORM_TENANT_PACKAGE_DIR ??= 'client-not-a-law-firm';
    process.env.PLATFORM_ENVIRONMENT ??= 'test';
    process.env.PLATFORM_POSTGRES_HOST ??= '127.0.0.1';
    process.env.PLATFORM_POSTGRES_PORT ??= '5432';
    process.env.PLATFORM_POSTGRES_RUNTIME_PASSWORD ??= 'onesquared_local_runtime';

    const partnerCtx = resolveTenantFromVerifiedToken({
      verifiedToken: {
        __verifiedByOidcMiddleware: true,
        sub: 'P-000001',
        tenantId: 'not-a-law-firm',
        email: 'rhian.morgan@notalawfirm.example',
        name: 'Rhian Morgan',
        roles: ['partner', 'admin'],
        mfaVerified: true,
      },
      hostingMode: 'multi_tenant',
      environment: 'test',
      correlationId: 'e2e-suggestion4-restricted-conflict',
    });
    const matterRepo = new TenantMatterRepository();
    const restrictedId = 'M-E2E-STAFF-CONFLICT';
    const existingRestricted = await matterRepo.getMatterById<Matter>(
      partnerCtx,
      restrictedId,
      { includeRestricted: true },
    );
    if (!existingRestricted) {
      const templateMatter = await matterRepo.getMatterById<Matter>(
        partnerCtx,
        'M-000011',
        { includeRestricted: true },
      );
      if (!templateMatter) {
        throw new Error('Expected seeded matter M-000011 in E2E database');
      }
      await matterRepo.putMatter(
        partnerCtx,
        {
          ...structuredClone(templateMatter),
          id: restrictedId,
          matterNumber: 'STF-E2E-999',
          title: 'Confidential E2E Staff Disciplinary Matter',
          shortDescription: 'Confidential internal staff grievance review',
          responsiblePartnerId: 'P-000001',
          supervisingPartnerId: 'P-000001',
          leadFeeEarnerId: 'P-000001',
          teamMemberIds: ['P-000001'],
          isStaffMatter: true,
          hasEthicalWall: true,
          restrictedAccessUserIds: ['P-000001'],
          parties: [
            {
              id: 'MP-E2E-STAFF-1',
              relationshipCode: 'OP',
              capacityCodes: [],
              entityType: 'organisation',
              linkedRecordId: null,
              name: 'Gower Harbour Logistics Ltd',
              role: 'Other party',
              notes: '',
            },
          ],
        },
        { expectedRowVersion: null },
      );
    }

    const context = await browser.newContext({
      storageState: storageStatePathFor('fee_earner'),
    });
    const page = await context.newPage();
    const pageErrors = attachPageErrorCollector(page);

    try {
      await page.goto('/enquiries/new');
      await expect(page.locator('#enq-first-name')).toBeVisible({ timeout: 15_000 });

      await page.locator('#enq-first-name').fill('Elen');
      await page.locator('#enq-last-name').fill('Morris');
      await page.locator('#enq-other-parties').fill('Gower Harbour Logistics Ltd');
      await page.locator('#enq-other-parties').blur();

      const mainArea = page.locator('.main-area');
      await expect(mainArea).toContainText('Possible conflicts', {
        timeout: 15_000,
      });
      await expect(mainArea).toContainText('Restricted matter');
      await expect(mainArea).not.toContainText(
        'Confidential E2E Staff Disciplinary Matter',
      );
      await expect(mainArea).not.toContainText('STF-E2E-999');
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
      await getGlobalTenantPostgresPoolManager().closeAllPools();
    }
  });
});
