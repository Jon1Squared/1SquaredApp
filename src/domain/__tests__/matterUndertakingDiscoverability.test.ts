import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CORE_REGISTER_TYPES,
  DEFAULT_REGISTERS_CONFIG,
} from '@platform/core';
import { describe, expect, it, vi } from 'vitest';
import { MatterProfileClient } from '@/components/MatterProfileClient';
import { RegistersWorkspaceClient } from '@/components/RegistersWorkspaceClient';
import { ToastProvider } from '@/components/Toast';
import { loadCommittedSeedStore } from '@/seed/seedSnapshot';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: () => {},
    refresh: () => {},
    replace: () => {},
    back: () => {},
  }),
  usePathname: () => '/matters/M-000001',
  useSearchParams: () => new URLSearchParams(),
}));

describe('R658: Undertaking creation discoverability on Matter profile & embedded Registers', () => {
  it('surfaces New undertaking action in Matter profile header and Overview card for fee earners with undertaking:manage', () => {
    const store = loadCommittedSeedStore();
    const matter = store.matters[0]!;
    const feeEarner = store.people.find((p) => p.id === 'P-000002')!;

    const html = renderToStaticMarkup(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(MatterProfileClient, {
          matter,
          initialTab: 'overview',
          people: store.people,
          organisations: store.organisations,
          values: store.values,
          tasks: store.tasks.filter((t) =>
            t.linkedRecords.some((l) => l.recordId === matter.id),
          ),
          teams: store.teams,
          enquiries: store.enquiries,
          quotes: store.quotes,
          currentUserId: feeEarner.id,
          currentUserRole: 'fee_earner',
          currentUser: feeEarner,
          employees: store.people.filter((p) => p.isEmployee),
          userPermissions: [
            'register:view',
            'register:create',
            'register:edit',
            'undertaking:manage',
          ],
          registersConfig: { ...DEFAULT_REGISTERS_CONFIG },
          registerTypes: Object.values(CORE_REGISTER_TYPES),
          matterRegisterRecords: [],
          matterRegisterTransitions: {},
          firmName: store.firm.name,
          notes: [],
          audit: [],
        }),
      ),
    );

    expect(html).toContain('data-testid="matter-header-new-undertaking"');
    expect(html).toContain('New undertaking');
    expect(html).toContain('Undertakings &amp; registers');
    expect(html).toContain('data-testid="matter-overview-new-undertaking"');
    expect(html).toContain('+ New undertaking');
  });

  it('offers explicit + New undertaking button and opens the Undertaking form immediately when requested in embedded RegistersWorkspaceClient', () => {
    const store = loadCommittedSeedStore();
    const matter = store.matters[0]!;
    const feeEarner = store.people.find((p) => p.id === 'P-000002')!;

    const embeddedProps = {
      embedded: true,
      lockedMatterId: matter.id,
      currentUserId: feeEarner.id,
      userPermissions: [
        'register:view' as const,
        'register:create' as const,
        'register:edit' as const,
        'undertaking:manage' as const,
      ],
      registerTypes: Object.values(CORE_REGISTER_TYPES),
      registersConfig: { ...DEFAULT_REGISTERS_CONFIG },
      initialRecords: [],
      initialTransitionsByRecordId: {},
      matters: [matter],
      people: store.people,
      initialOpenCreateTypeKey: 'undertaking',
    };

    const html = renderToStaticMarkup(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(RegistersWorkspaceClient, embeddedProps),
      ),
    );

    expect(html).toContain('+ New undertaking');
    expect(html).toContain('+ New register entry');
    expect(html).toContain('New Undertaking');
    expect(html).toContain('Recipient / counterparty');
  });

  it('hides undertaking creation buttons from users lacking undertaking:manage', () => {
    const store = loadCommittedSeedStore();
    const matter = store.matters[0]!;
    const legalSecretary =
      store.people.find((p) => p.id === 'P-000043') ??
      store.people.find((p) => p.isEmployee && p.id !== 'P-000002')!;

    const matterHtml = renderToStaticMarkup(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(MatterProfileClient, {
          matter,
          initialTab: 'overview',
          people: store.people,
          organisations: store.organisations,
          values: store.values,
          tasks: [],
          teams: store.teams,
          enquiries: [],
          quotes: [],
          currentUserId: legalSecretary.id,
          currentUserRole: 'call_handler',
          currentUser: legalSecretary,
          employees: store.people.filter((p) => p.isEmployee),
          userPermissions: ['register:view', 'register:create'],
          registersConfig: { ...DEFAULT_REGISTERS_CONFIG },
          registerTypes: Object.values(CORE_REGISTER_TYPES),
          matterRegisterRecords: [],
          matterRegisterTransitions: {},
          firmName: store.firm.name,
          notes: [],
          audit: [],
        }),
      ),
    );

    expect(matterHtml).not.toContain('data-testid="matter-header-new-undertaking"');
    expect(matterHtml).not.toContain('data-testid="matter-overview-new-undertaking"');

    const embeddedHtml = renderToStaticMarkup(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(RegistersWorkspaceClient, {
          embedded: true,
          lockedMatterId: matter.id,
          currentUserId: legalSecretary.id,
          userPermissions: ['register:view', 'register:create'],
          registerTypes: Object.values(CORE_REGISTER_TYPES),
          registersConfig: { ...DEFAULT_REGISTERS_CONFIG },
          initialRecords: [],
          initialTransitionsByRecordId: {},
          matters: [matter],
          people: store.people,
        }),
      ),
    );

    expect(embeddedHtml).not.toContain('+ New undertaking');
    expect(embeddedHtml).toContain('+ New register entry');
  });
});
