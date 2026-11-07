import { expect, test, type Page } from '@playwright/test';
import { createDefaultRbacConfig } from '../core/src/domain/rbac/registry';
import {
  getLeftRailVisibility,
  type LeftRailVisibility,
} from '../src/domain/homeConfig';
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

      // 3. Main action: open Matters list and click into a matter workspace
      await page.locator('aside.left-rail a.rail-item[href="/matters"]').click();
      await expect(page).toHaveURL(/\/matters$/);
      const matterLink = page.locator('a[href^="/matters/M-"]').first();
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
