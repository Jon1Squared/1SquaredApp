import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMatterExtractionCacheForTesting,
  POST as matterExtractPost,
} from '@/app/api/matters/extract/route';
import {
  setActiveTenantConfigForTesting,
} from '@/platform/tenantRuntime';
import { setTestEntraSessionOverride } from '@/server/entraAuth';
import { resetAllDemoData } from '@/server/services';
import { getStore } from '@/server/store';
import { buildRecordVisibility } from '@/server/visibility';

const ORIGINAL_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_FETCH = globalThis.fetch;

const FEE_EARNER_SESSION = {
  personId: 'P-000002',
  tenantId: 'not-a-law-firm',
  oid: '00000000-0000-4000-8000-000000000002',
  tid: '11111111-2222-3333-4444-000000000000',
  sub: 'P-000002',
  email: 'dafydd.evans@notalawfirm.example',
  displayName: 'Dafydd Evans',
  entraRoles: ['fee_earner'],
  mappedRoles: ['fee_earner'],
  entraGroups: [],
  mfaVerified: true,
  amr: ['pwd', 'mfa'],
  authenticatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

const FINANCE_SESSION = {
  ...FEE_EARNER_SESSION,
  personId: 'P-000009',
  oid: '00000000-0000-4000-8000-000000000009',
  sub: 'P-000009',
  email: 'gethin.powell@notalawfirm.example',
  displayName: 'Gethin Powell',
  entraRoles: ['finance'],
  mappedRoles: ['finance'],
};

function buildExtractRequest(content = 'Instruction email for a new employment matter.') {
  return new Request('http://localhost:3000/api/matters/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documents: [
        {
          id: 'doc-1',
          name: 'instruction.eml',
          kind: 'email',
          content,
        },
      ],
    }),
  });
}

function mockAnthropicSuccessResponse(overrides?: Record<string, unknown>) {
  const payload = {
    summary: 'New employment instruction for Invented Freight Ltd.',
    client: {
      type: 'Company',
      name: { value: 'Invented Freight Ltd', source: ['instruction.eml'] },
      company_number: { value: '99887766', source: ['instruction.eml'] },
      instructing_contact: {
        name: 'claire.benson@inventedfreight.example',
        jobTitle: 'HR Director',
        email: 'claire.benson@inventedfreight.example',
        phone: '01632 960123',
        source: ['instruction.eml'],
      },
    },
    matters: [
      {
        matter_ref: 'Matter A',
        title: { value: 'ET Claim Defence', source: ['instruction.eml'] },
        work_type: 'Employment & HR',
        sub_type: 'Employment Tribunal',
        description: { value: 'Employment tribunal defence', source: ['instruction.eml'] },
        fee_earner: 'Unmatched Imaginary Partner (Partner)',
        other_parties_for_conflict_check: [
          {
            name: 'Alex Opponent',
            entity_type: 'person',
            role: 'Claimant',
            relationship_code: 'OP',
            source: ['instruction.eml'],
          },
        ],
      },
    ],
    ...overrides,
  };
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/models')) {
      return new Response(
        JSON.stringify({ data: [{ id: 'claude-sonnet-4-5-20250929' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

describe('S0-06: POST /api/matters/extract permissions, tenant settings, B10, and isolation', () => {
  beforeEach(async () => {
    await resetAllDemoData('P-000001');
    clearMatterExtractionCacheForTesting();
    setActiveTenantConfigForTesting(null);
    setTestEntraSessionOverride(FEE_EARNER_SESSION);
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-fixture';
  });

  afterEach(async () => {
    clearMatterExtractionCacheForTesting();
    setActiveTenantConfigForTesting(null);
    setTestEntraSessionOverride(undefined);
    if (ORIGINAL_ANTHROPIC_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_KEY;
    }
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
    await resetAllDemoData('P-000001');
  });

  it('returns 403 FORBIDDEN when signed in without matter:create', async () => {
    setTestEntraSessionOverride(FINANCE_SESSION);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await matterExtractPost(buildExtractRequest());
    expect(res.status).toBe(403);
    const json = (await res.json()) as { code?: string; denied?: boolean };
    expect(json.code).toBe('FORBIDDEN');
    expect(json.denied).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    const denialLog = JSON.parse(String(warnSpy.mock.calls[0]?.[0] ?? '{}')) as {
      event?: string;
      code?: string;
      requiredPermission?: string;
    };
    expect(denialLog.event).toBe('authorisation.denied');
    expect(denialLog.code).toBe('FORBIDDEN');
    expect(denialLog.requiredPermission).toBe('matter:create');
  });

  it('returns 403 AI_EXTRACTION_DISABLED when enableAiMatterExtraction is false or aiProviderChoice is not anthropic, with no call to Anthropic', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // 1. enableAiMatterExtraction = false
    setActiveTenantConfigForTesting(null, {
      featureFlags: {
        enableAiMatterExtraction: false,
      },
      integrations: {
        aiProviderChoice: 'anthropic',
      },
    });
    const disabledFlagRes = await matterExtractPost(buildExtractRequest());
    expect(disabledFlagRes.status).toBe(403);
    const disabledFlagJson = (await disabledFlagRes.json()) as { code?: string };
    expect(disabledFlagJson.code).toBe('AI_EXTRACTION_DISABLED');
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. aiProviderChoice = 'disabled'
    setActiveTenantConfigForTesting(null, {
      featureFlags: {
        enableAiMatterExtraction: true,
      },
      integrations: {
        aiProviderChoice: 'disabled',
      },
    });
    const disabledProviderRes = await matterExtractPost(buildExtractRequest());
    expect(disabledProviderRes.status).toBe(403);
    const disabledProviderJson = (await disabledProviderRes.json()) as { code?: string };
    expect(disabledProviderJson.code).toBe('AI_EXTRACTION_DISABLED');
    expect(fetchSpy).not.toHaveBeenCalled();

    // 3. aiProviderChoice = 'azure_openai_uk'
    setActiveTenantConfigForTesting(null, {
      featureFlags: {
        enableAiMatterExtraction: true,
      },
      integrations: {
        aiProviderChoice: 'azure_openai_uk',
      },
    });
    const azureProviderRes = await matterExtractPost(buildExtractRequest());
    expect(azureProviderRes.status).toBe(403);
    const azureProviderJson = (await azureProviderRes.json()) as { code?: string };
    expect(azureProviderJson.code).toBe('AI_EXTRACTION_DISABLED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never creates employees (B10), checks contact:create before creating contacts/orgs/links, and returns no unrelated records', async () => {
    const storeBefore = getStore();
    const employeeIdsBefore = storeBefore.people
      .filter((p) => p.isEmployee)
      .map((p) => p.id);

    globalThis.fetch = mockAnthropicSuccessResponse({
      client: {
        type: 'Company',
        name: { value: 'Invented Logistics Ltd', source: ['instruction.eml'] },
        company_number: { value: '88776655', source: ['instruction.eml'] },
        instructing_contact: {
          name: 'Gareth Bowen',
          jobTitle: 'Operations Director',
          email: 'gareth.bowen@inventedlogistics.example',
          phone: '01632 960456',
          source: ['instruction.eml'],
        },
      },
    }) as unknown as typeof fetch;

    const res = await matterExtractPost(buildExtractRequest());
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      extraction: {
        client?: { matchedRecordId?: string; createdNewRecord?: boolean };
        instructingContact?: { matchedPersonId?: string; createdNewRecord?: boolean };
        leadFeeEarner?: { name?: string; matchedPersonId?: string };
        responsiblePartner?: { name?: string; matchedPersonId?: string };
      };
      organisations: Array<{ id: string }>;
      people: Array<{ id: string; isEmployee?: boolean }>;
      links: Array<{ id: string; personId: string; organisationId: string }>;
    };

    // B10: No employee was created; unmatched partner stays unmatched suggestion
    const storeAfter = getStore();
    const employeeIdsAfter = storeAfter.people
      .filter((p) => p.isEmployee)
      .map((p) => p.id);
    expect(employeeIdsAfter).toEqual(employeeIdsBefore);
    expect(data.extraction.leadFeeEarner?.matchedPersonId).toBeUndefined();
    expect(data.extraction.responsiblePartner?.matchedPersonId).toBeUndefined();

    // Scoped response: contains ONLY the created/matched client org, instructing contact, and their link
    const createdOrgId = data.extraction.client?.matchedRecordId;
    const createdPersonId = data.extraction.instructingContact?.matchedPersonId;
    expect(createdOrgId).toBeTruthy();
    expect(createdPersonId).toBeTruthy();
    expect(data.organisations.map((o) => o.id)).toEqual([createdOrgId]);
    expect(data.people.map((p) => p.id)).toEqual([createdPersonId]);
    expect(data.people.every((p) => !p.isEmployee)).toBe(true);
    expect(
      data.links.every(
        (l) => l.personId === createdPersonId && l.organisationId === createdOrgId,
      ),
    ).toBe(true);

    // When actor lacks contact:create, no new client org, person, or link is created
    clearMatterExtractionCacheForTesting();
    const actor = storeAfter.people.find((p) => p.id === 'P-000002')!;
    actor.permissionOverrides = {
      grant: [],
      revoke: ['contact:create'],
    };
    const orgCountBeforeNoContactCreate = storeAfter.organisations.length;
    const peopleCountBeforeNoContactCreate = storeAfter.people.length;

    globalThis.fetch = mockAnthropicSuccessResponse({
      client: {
        type: 'Company',
        name: { value: 'Another Unmatched Co Ltd', source: ['instruction.eml'] },
        company_number: { value: '77665544', source: ['instruction.eml'] },
        instructing_contact: {
          name: 'Sian Meredith',
          jobTitle: 'Director',
          email: 'sian.meredith@anotherco.example',
          source: ['instruction.eml'],
        },
      },
    }) as unknown as typeof fetch;

    const noContactCreateRes = await matterExtractPost(
      buildExtractRequest('Second instruction without contact:create.'),
    );
    expect(noContactCreateRes.status).toBe(200);
    const noContactCreateData = (await noContactCreateRes.json()) as {
      extraction: {
        client?: { matchedRecordId?: string; createdNewRecord?: boolean };
        instructingContact?: { matchedPersonId?: string; createdNewRecord?: boolean };
      };
    };
    expect(noContactCreateData.extraction.client?.matchedRecordId).toBeUndefined();
    expect(noContactCreateData.extraction.instructingContact?.matchedPersonId).toBeUndefined();
    expect(getStore().organisations.length).toBe(orgCountBeforeNoContactCreate);
    expect(getStore().people.length).toBe(peopleCountBeforeNoContactCreate);

    // R263 (3): When both the organisation and the contact already exist in the CRM, lacking contact:create prevents linking them
    clearMatterExtractionCacheForTesting();
    const existingOrg = getStore().organisations[0]!;
    const unlinkedPerson = {
      ...structuredClone(getStore().people.find((p) => !p.isEmployee)!),
      id: 'P-UNLINKED-EXT-01',
      firstName: 'Nerys',
      surname: 'UnlinkedContact',
      isEmployee: false,
      emails: [
        {
          id: 'em-unlinked-1',
          address: 'nerys.unlinked@notalawfirm.example',
          typeId: 'email_type.work',
          isPrimary: true,
        },
      ],
    };
    getStore().people.push(unlinkedPerson);
    const linksBeforeExistingMatch = getStore().links.length;

    globalThis.fetch = mockAnthropicSuccessResponse({
      client: {
        type: 'Company',
        name: { value: existingOrg.legalName, source: ['instruction.eml'] },
        company_number: { value: existingOrg.companyNumber || '', source: ['instruction.eml'] },
        instructing_contact: {
          name: 'Nerys UnlinkedContact',
          jobTitle: 'General Counsel',
          email: 'nerys.unlinked@notalawfirm.example',
          source: ['instruction.eml'],
        },
      },
    }) as unknown as typeof fetch;

    const existingWithoutCreateRes = await matterExtractPost(
      buildExtractRequest('Third instruction matching existing org and unlinked contact without contact:create.'),
    );
    expect(existingWithoutCreateRes.status).toBe(200);
    const existingWithoutCreateData = (await existingWithoutCreateRes.json()) as {
      extraction: {
        client?: { matchedRecordId?: string; createdNewRecord?: boolean };
        instructingContact?: { matchedPersonId?: string; createdNewRecord?: boolean };
      };
      links: Array<{ id: string; personId: string; organisationId: string }>;
    };
    expect(existingWithoutCreateData.extraction.client?.matchedRecordId).toBe(existingOrg.id);
    expect(existingWithoutCreateData.extraction.instructingContact?.matchedPersonId).toBe(
      unlinkedPerson.id,
    );
    expect(existingWithoutCreateData.links).toEqual([]);
    expect(getStore().links.length).toBe(linksBeforeExistingMatch);
    expect(
      getStore().links.some(
        (l) => l.personId === unlinkedPerson.id && l.organisationId === existingOrg.id,
      ),
    ).toBe(false);
  });

  it('excludes a person created from a hidden enquiry from CRM matching and the response while matching a person created from a visible enquiry with the same name (R263, R291, R300)', async () => {
    const store = getStore();
    const feeEarner = store.people.find((p) => p.id === 'P-000002')!;
    // Create a private Draft enquiry owned by P-000001 (hidden from P-000002) and a routed enquiry assigned to P-000002 (visible to P-000002)
    const hiddenEnq = {
      ...structuredClone(store.enquiries[0]!),
      id: 'ENQ-HIDDEN-S006',
      reference: 'ENQ-HIDDEN-S006',
      status: 'Draft' as const,
      createdById: 'P-000001',
      takenById: 'P-000001',
      assignedToId: null,
      assignedTeamId: null,
      convertedMatterId: null,
      firstName: 'Idris',
      lastName: 'HiddenEnquirer',
    };
    const visibleEnq = {
      ...structuredClone(store.enquiries[0]!),
      id: 'ENQ-VISIBLE-S006',
      reference: 'ENQ-VISIBLE-S006',
      status: 'Assigned' as const,
      createdById: feeEarner.id,
      takenById: feeEarner.id,
      assignedToId: feeEarner.id,
      convertedMatterId: null,
      firstName: 'Bryn',
      lastName: 'SameNameEnquirer',
    };
    const hiddenEnqPerson = {
      ...structuredClone(store.people.find((p) => !p.isEmployee)!),
      id: 'P-HIDDEN-ENQ-S006',
      firstName: 'Idris',
      surname: 'HiddenEnquirer',
      isEmployee: false,
      createdFromEnquiryId: hiddenEnq.id,
      emails: [
        {
          id: 'em-hidden-s006',
          address: 'idris.hidden@notalawfirm.example',
          typeId: 'email_type.personal',
          isPrimary: true,
        },
      ],
    };
    const sameNameHiddenPerson = {
      ...structuredClone(store.people.find((p) => !p.isEmployee)!),
      id: 'P-SAMENAME-HIDDEN-S006',
      firstName: 'Bryn',
      surname: 'SameNameEnquirer',
      isEmployee: false,
      createdFromEnquiryId: hiddenEnq.id,
      emails: [
        {
          id: 'em-samename-hidden-s006',
          address: 'bryn.hidden@notalawfirm.example',
          typeId: 'email_type.personal',
          isPrimary: true,
        },
      ],
    };
    const sameNameVisiblePerson = {
      ...structuredClone(store.people.find((p) => !p.isEmployee)!),
      id: 'P-SAMENAME-VISIBLE-S006',
      firstName: 'Bryn',
      surname: 'SameNameEnquirer',
      isEmployee: false,
      createdFromEnquiryId: visibleEnq.id,
      emails: [
        {
          id: 'em-samename-visible-s006',
          address: 'bryn.visible@notalawfirm.example',
          typeId: 'email_type.personal',
          isPrimary: true,
        },
      ],
    };
    store.enquiries.push(hiddenEnq, visibleEnq);
    // Push the hidden-enquiry person BEFORE the visible-enquiry person so an unfiltered .find() would pick the hidden one
    store.people.push(hiddenEnqPerson, sameNameHiddenPerson, sameNameVisiblePerson);

    const visibility = buildRecordVisibility(store, feeEarner);
    expect(visibility.canViewEnquiry(hiddenEnq)).toBe(false);
    expect(visibility.canViewEnquiry(visibleEnq)).toBe(true);

    globalThis.fetch = mockAnthropicSuccessResponse({
      matters: [
        {
          matter_ref: 'Matter A',
          title: { value: 'ET Claim Defence', source: ['instruction.eml'] },
          work_type: 'Employment & HR',
          sub_type: 'Employment Tribunal',
          description: { value: 'Employment tribunal defence', source: ['instruction.eml'] },
          other_parties_for_conflict_check: [
            {
              name: 'Idris HiddenEnquirer',
              entity_type: 'person',
              role: 'Claimant',
              relationship_code: 'OP',
              source: ['instruction.eml'],
            },
            {
              name: 'Bryn SameNameEnquirer',
              entity_type: 'person',
              role: 'Co-Claimant',
              relationship_code: 'OP',
              source: ['instruction.eml'],
            },
          ],
        },
      ],
    }) as unknown as typeof fetch;

    const res = await matterExtractPost(
      buildExtractRequest(
        'Instruction naming Idris HiddenEnquirer from a hidden enquiry and Bryn SameNameEnquirer from a visible enquiry.',
      ),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      extraction: {
        otherParties?: Array<{ name: string; matchedRecordId?: string }>;
        matters?: Array<{ otherParties?: Array<{ name: string; matchedRecordId?: string }> }>;
      };
      people: Array<{ id: string }>;
    };

    expect(data.people.some((p) => p.id === hiddenEnqPerson.id)).toBe(false);
    expect(data.people.some((p) => p.id === sameNameHiddenPerson.id)).toBe(false);
    expect(data.people.some((p) => p.id === sameNameVisiblePerson.id)).toBe(true);
    expect(JSON.stringify(data)).not.toContain(hiddenEnqPerson.id);
    expect(JSON.stringify(data)).not.toContain(sameNameHiddenPerson.id);

    const allParties = [
      ...(data.extraction.otherParties ?? []),
      ...(data.extraction.matters ?? []).flatMap((m) => m.otherParties ?? []),
    ];
    expect(allParties.some((pt) => pt.matchedRecordId === hiddenEnqPerson.id)).toBe(false);
    expect(allParties.some((pt) => pt.matchedRecordId === sameNameHiddenPerson.id)).toBe(false);
    expect(
      allParties.some(
        (pt) =>
          pt.name === 'Bryn SameNameEnquirer' &&
          pt.matchedRecordId === sameNameVisiblePerson.id,
      ),
    ).toBe(true);
  });

  it('labels local fallback provenance as local-fallback and hides internal error messages on 500', async () => {
    // 1. Remote non-auth failure triggers deterministic fallback labelled 'local-fallback'
    globalThis.fetch = vi.fn(async () => new Response('Server busy', { status: 502 })) as unknown as typeof fetch;

    const fallbackRes = await matterExtractPost(
      buildExtractRequest('Offline fallback test document.'),
    );
    expect(fallbackRes.status).toBe(200);
    const fallbackData = (await fallbackRes.json()) as {
      extraction: { modelName: string };
    };
    expect(fallbackData.extraction.modelName).toBe('local-fallback');

    // 2. Thrown error returns stable code EXTRACTION_FAILED on 500 without leaking err.message or document text
    clearMatterExtractionCacheForTesting();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () =>
      new Response('Sensitive upstream internal detail', { status: 401 }),
    ) as unknown as typeof fetch;

    const errRes = await matterExtractPost(
      buildExtractRequest('TopSecretClientInstructionText-DoNotLog'),
    );
    expect(errRes.status).toBe(500);
    const errJson = (await errRes.json()) as {
      code?: string;
      error?: string;
      correlationId?: string;
    };
    expect(errJson.code).toBe('EXTRACTION_FAILED');
    expect(errJson.error).not.toContain('Sensitive upstream internal detail');
    expect(errJson.correlationId).toBeTruthy();

    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(logged).not.toContain('TopSecretClientInstructionText-DoNotLog');
    expect(logged).not.toContain('Sensitive upstream internal detail');
    const parsedLog = JSON.parse(logged) as {
      event?: string;
      tenantId?: string;
      correlationId?: string;
      errorCode?: string;
    };
    expect(parsedLog.event).toBe('matter_ai_extraction.failed');
    expect(parsedLog.tenantId).toBe('not-a-law-firm');
    expect(parsedLog.errorCode).toBe('EXTRACTION_FAILED');
  });

  it('enforces two-tenant cache isolation and rejects a forged tenant claim', async () => {
    let anthropicCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'claude-sonnet-4-5-20250929' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      anthropicCalls += 1;
      const tenantSpecificTitle =
        anthropicCalls === 1 ? 'Tenant A Matter Title' : 'Tenant B Matter Title';
      return new Response(
        JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                summary: tenantSpecificTitle,
                matters: [
                  {
                    matter_ref: 'Matter A',
                    title: { value: tenantSpecificTitle, source: ['instruction.eml'] },
                    work_type: 'Employment & HR',
                  },
                ],
              }),
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const sharedDocText = 'Identical uploaded document text across two tenants.';

    // 1. Tenant A ('not-a-law-firm'), User 1 ('P-000002') runs extraction -> cache miss (call 1), repeat call -> cache hit
    const resA = await matterExtractPost(buildExtractRequest(sharedDocText));
    expect(resA.status).toBe(200);
    const dataA = (await resA.json()) as { extraction: { summary: string } };
    expect(dataA.extraction.summary).toBe('Tenant A Matter Title');
    expect(anthropicCalls).toBe(1);

    const resARepeat = await matterExtractPost(buildExtractRequest(sharedDocText));
    expect(resARepeat.status).toBe(200);
    expect(anthropicCalls).toBe(1);

    // 1b. R263 (1): Same tenant ('not-a-law-firm'), different user ('P-000001') -> cache miss
    setTestEntraSessionOverride({
      ...FEE_EARNER_SESSION,
      personId: 'P-000001',
      oid: '00000000-0000-4000-8000-000000000001',
      sub: 'P-000001',
      email: 'carys.hughes@notalawfirm.example',
      displayName: 'Carys Hughes',
      entraRoles: ['partner'],
      mappedRoles: ['partner'],
    });
    const resDifferentUserSameTenant = await matterExtractPost(
      buildExtractRequest(sharedDocText),
    );
    expect(resDifferentUserSameTenant.status).toBe(200);
    expect(anthropicCalls).toBe(2);

    // 2. Forged tenant claim ('pembroke-vaughan' while active tenant is 'not-a-law-firm') is rejected
    setTestEntraSessionOverride({
      ...FEE_EARNER_SESSION,
      tenantId: 'pembroke-vaughan',
    });
    await expect(
      matterExtractPost(buildExtractRequest(sharedDocText)),
    ).rejects.toThrow(/TENANCY_FORGERY_DETECTED/);
    expect(anthropicCalls).toBe(2);

    // 3. Switch active tenant to Tenant B ('pembroke-vaughan') and sign in as Tenant B -> cache miss (never returns Tenant A's result)
    setActiveTenantConfigForTesting(null, {
      tenantId: 'pembroke-vaughan',
      displayName: 'Pembroke Vaughan',
    });
    setTestEntraSessionOverride({
      ...FEE_EARNER_SESSION,
      tenantId: 'pembroke-vaughan',
    });
    const resB = await matterExtractPost(buildExtractRequest(sharedDocText));
    expect(resB.status).toBe(200);
    const dataB = (await resB.json()) as { extraction: { summary: string } };
    expect(dataB.extraction.summary).toBe('Tenant B Matter Title');
    expect(anthropicCalls).toBe(3);
  });
});
