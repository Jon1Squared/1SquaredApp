import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildMatterRiskAssessmentSnapshot,
  MATTER_RISK_SECTIONS,
  summarizeMatterRiskAssessment,
  validateMatterRiskAssessmentInput,
  type MatterRiskAssessmentSnapshot,
} from '@/domain/matterOpeningRecord';
import {
  createSignedEntraSessionCookie,
  verifySignedEntraSessionCookie,
} from '@/server/entraAuth';
import { resetAllDemoData, saveMatterRecord } from '@/server/services';
import { runWithActiveActorSession } from '@/server/rbacRuntime';
import { getStore } from '@/server/store';

function buildVerifiedActorSession(personId = 'P-000001') {
  const store = getStore();
  const person = store.people.find((p) => p.id === personId)!;
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const prevSecret = process.env.ENTRA_SESSION_SIGNING_SECRET;
  if (!prevSecret) {
    process.env.ENTRA_SESSION_SIGNING_SECRET =
      's0-08-test-session-signing-secret-32-bytes-min';
  }
  const cookie = createSignedEntraSessionCookie({
    personId: person.id,
    tenantId: 'not-a-law-firm',
    oid: person.entraObjectId ?? '00000000-0000-4000-8000-000000000001',
    tid: '11111111-2222-3333-4444-000000000000',
    sub: person.id,
    email: person.emails[0]?.address ?? 'rhian.morgan@notalawfirm.example',
    displayName: `${person.firstName} ${person.surname}`,
    entraRoles: person.roles ?? ['partner', 'fee_earner'],
    mappedRoles: person.roles ?? ['partner', 'fee_earner'],
    entraGroups: [],
    mfaVerified: true,
    amr: ['pwd', 'mfa'],
    authenticatedAt: new Date().toISOString(),
    expiresAt,
  });
  const verifiedSession = verifySignedEntraSessionCookie(cookie)!;
  return {
    personId: person.id,
    tenantId: 'not-a-law-firm',
    tokenRoles: verifiedSession.mappedRoles,
    expiresAtMs: Date.parse(expiresAt),
    verifiedSession,
  };
}

describe('S0-08: Matter risk assessment answers kept and scored on the server (B1, Item 4)', () => {
  beforeEach(() => {
    resetAllDemoData('P-000001');
  });

  it('1. New matter: stores entered questionnaire answers and sets overallRisk and riskRatingId from server scoring (ignoring client riskRatingId and forged snapshot fields)', async () => {
    const store = getStore();
    const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
    const { id: _omittedId, ...matterTemplate } = baseMatter;
    void _omittedId;
    const actorSession = buildVerifiedActorSession('P-000001');

    await runWithActiveActorSession(actorSession, async () => {
      const saveRes = await saveMatterRecord(
        {
          ...matterTemplate,
          title: 'S0-08 New Matter With Medium Risk Answers',
          // Client sends Low rating and forged Low snapshot, but answers include Medium risk options
          riskRatingId: 'risk_rating.low',
          fieldValues: {
            riskAssessment: {
              overallRisk: 'Low',
              completedQuestions: 99,
              sections: [{ id: 'forged', title: 'Forged' }],
              answers: {
                inScopeMlr: 'Yes, in scope',
                instructionMakesSense: 'Not sure',
                clientRelationshipStatus: 'New client',
                clientDealingMethod: 'Met in person',
              },
              followUps: {
                instructionMakesSense:
                  'Unusual asset acquisition outside normal operations',
              },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'draft' },
      );

      expect(saveRes.errors).toBeUndefined();
      expect(saveRes.matter).not.toBeNull();

      const savedSnapshot = saveRes.matter!.fieldValues[
        'riskAssessment'
      ] as MatterRiskAssessmentSnapshot;
      expect(savedSnapshot).toBeDefined();
      expect(savedSnapshot.answers).toEqual({
        inScopeMlr: 'Yes, in scope',
        instructionMakesSense: 'Not sure',
        clientRelationshipStatus: 'New client',
        clientDealingMethod: 'Met in person',
      });
      expect(savedSnapshot.followUps).toEqual({
        instructionMakesSense:
          'Unusual asset acquisition outside normal operations',
      });
      // Server-scored overallRisk is Medium (from 'Not sure' and 'New client'), overriding client 'Low'
      expect(savedSnapshot.overallRisk).toBe('Medium');
      expect(saveRes.matter!.riskRatingId).toBe('risk_rating.medium');
      expect(savedSnapshot.completedQuestions).toBe(4);
      expect(savedSnapshot.sections[0].id).toBe('about_instruction');
    });
  });

  it('2. Edit: changing an answer on an existing matter replaces the stored snapshot and updates riskRatingId; saving without answers keeps the existing snapshot', async () => {
    const store = getStore();
    const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
    const { id: _omittedId, ...matterTemplate } = baseMatter;
    void _omittedId;
    const actorSession = buildVerifiedActorSession('P-000001');

    await runWithActiveActorSession(actorSession, async () => {
      // Initial save with Low-risk answers
      const initialRes = await saveMatterRecord(
        {
          ...matterTemplate,
          title: 'S0-08 Editable Matter',
          riskAssessment: {
            answers: {
              inScopeMlr: 'Yes, in scope',
              instructionMakesSense: 'Yes',
              clientRelationshipStatus: 'Existing, CDD current',
              highRiskJurisdictionLink: 'No',
            },
            followUps: {},
          },
        },
        { byId: 'P-000001', saveMode: 'draft' },
      );

      expect(initialRes.errors).toBeUndefined();
      const matterId = initialRes.matter!.id;
      const initialSnapshot = initialRes.matter!.fieldValues[
        'riskAssessment'
      ] as MatterRiskAssessmentSnapshot;
      expect(initialSnapshot.overallRisk).toBe('Low');
      expect(initialRes.matter!.riskRatingId).toBe('risk_rating.low');

      // Edit: change highRiskJurisdictionLink to 'Yes' (High risk)
      const editedRes = await saveMatterRecord(
        {
          ...initialRes.matter!,
          title: 'S0-08 Editable Matter',
          riskRatingId: 'risk_rating.low', // client sends stale rating; server must override
          fieldValues: {
            riskAssessment: {
              answers: {
                inScopeMlr: 'Yes, in scope',
                instructionMakesSense: 'Yes',
                clientRelationshipStatus: 'Existing, CDD current',
                highRiskJurisdictionLink: 'Yes',
              },
              followUps: {
                highRiskJurisdictionLink:
                  'Counterparty parent incorporated in high-risk jurisdiction',
              },
            },
          },
        },
        { id: matterId, byId: 'P-000001', saveMode: 'draft' },
      );

      expect(editedRes.errors).toBeUndefined();
      const editedSnapshot = editedRes.matter!.fieldValues[
        'riskAssessment'
      ] as MatterRiskAssessmentSnapshot;
      expect(editedSnapshot.answers.highRiskJurisdictionLink).toBe('Yes');
      expect(editedSnapshot.followUps.highRiskJurisdictionLink).toBe(
        'Counterparty parent incorporated in high-risk jurisdiction',
      );
      expect(editedSnapshot.overallRisk).toBe('High');
      expect(editedRes.matter!.riskRatingId).toBe('risk_rating.high');

      // Save without riskAssessment answers: existing snapshot and High rating are preserved
      const { riskAssessment: _omittedRisk, ...otherFieldValues } =
        editedRes.matter!.fieldValues;
      void _omittedRisk;
      const titleOnlyEditRes = await saveMatterRecord(
        {
          ...editedRes.matter!,
          title: 'S0-08 Editable Matter (Title Updated)',
          riskRatingId: 'risk_rating.low',
          fieldValues: otherFieldValues,
        },
        { id: matterId, byId: 'P-000001', saveMode: 'draft' },
      );

      expect(titleOnlyEditRes.errors).toBeUndefined();
      const preservedSnapshot = titleOnlyEditRes.matter!.fieldValues[
        'riskAssessment'
      ] as MatterRiskAssessmentSnapshot;
      expect(preservedSnapshot.answers.highRiskJurisdictionLink).toBe('Yes');
      expect(preservedSnapshot.overallRisk).toBe('High');
      expect(titleOnlyEditRes.matter!.riskRatingId).toBe('risk_rating.high');
    });
  });

  it('3. Validation: rejects an unknown question ID or unknown answer value with errors.riskAssessment', async () => {
    // Pure domain validation checks
    const badQuestionId = validateMatterRiskAssessmentInput({
      answers: {
        inScopeMlr: 'Yes, in scope',
        nonExistentQuestionId: 'Yes',
      },
    });
    expect(badQuestionId.ok).toBe(false);
    if (!badQuestionId.ok) {
      expect(badQuestionId.error).toContain('nonExistentQuestionId');
    }

    const badOptionValue = validateMatterRiskAssessmentInput({
      answers: {
        inScopeMlr: 'Not an allowed option',
      },
    });
    expect(badOptionValue.ok).toBe(false);
    if (!badOptionValue.ok) {
      expect(badOptionValue.error).toContain('Not an allowed option');
    }

    const badFollowUpQuestionId = validateMatterRiskAssessmentInput({
      answers: { inScopeMlr: 'Yes, in scope' },
      followUps: { bogusFollowUpKey: 'Some text' },
    });
    expect(badFollowUpQuestionId.ok).toBe(false);
    if (!badFollowUpQuestionId.ok) {
      expect(badFollowUpQuestionId.error).toContain('bogusFollowUpKey');
    }

    // Service-level enforcement in saveMatterRecord
    const store = getStore();
    const baseMatter = store.matters.find((m) => m.id === 'M-000001')!;
    const { id: _omittedId, ...matterTemplate } = baseMatter;
    void _omittedId;
    const actorSession = buildVerifiedActorSession('P-000001');

    await runWithActiveActorSession(actorSession, async () => {
      const unknownQRes = await saveMatterRecord(
        {
          ...matterTemplate,
          title: 'S0-08 Invalid Question ID Matter',
          fieldValues: {
            riskAssessment: {
              answers: {
                unknownQuestionKey: 'Yes',
              },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'draft' },
      );
      expect(unknownQRes.matter).toBeNull();
      expect(unknownQRes.errors?.riskAssessment).toMatch(
        /Unknown risk assessment question ID "unknownQuestionKey"/,
      );

      const unknownValRes = await saveMatterRecord(
        {
          ...matterTemplate,
          title: 'S0-08 Invalid Answer Value Matter',
          fieldValues: {
            riskAssessment: {
              answers: {
                highRiskJurisdictionLink: 'Maybe later',
              },
            },
          },
        },
        { byId: 'P-000001', saveMode: 'draft' },
      );
      expect(unknownValRes.matter).toBeNull();
      expect(unknownValRes.errors?.riskAssessment).toMatch(
        /Invalid answer "Maybe later" for risk assessment question "highRiskJurisdictionLink"/,
      );
    });
  });

  it('4. Completion: client summary (summarizeMatterRiskAssessment) and server builder (buildMatterRiskAssessmentSnapshot) count completed questions identically, including follow-up rules and MLR scope', () => {
    // (a) Question with triggersFollowUp: true is NOT counted as completed until its follow-up is provided
    const answersWithPendingFollowUp: Record<string, string> = {
      inScopeMlr: 'Yes, in scope',
      instructionMakesSense: 'Not sure', // triggersFollowUp: true
      imminentDeadlines: 'Yes', // triggersFollowUp: true, followUpType: 'key_dates'
    };

    const clientBeforeFollowUp = summarizeMatterRiskAssessment({
      answers: answersWithPendingFollowUp,
      followUps: {},
      customKeyDates: [],
    });
    const serverBeforeFollowUp = buildMatterRiskAssessmentSnapshot({
      answers: answersWithPendingFollowUp,
      followUps: {},
      customKeyDates: [],
      completedById: 'P-000001',
      completedByName: 'Rhian Morgan',
    });

    // Only inScopeMlr is complete; instructionMakesSense and imminentDeadlines require follow-ups
    expect(clientBeforeFollowUp.completedQuestions).toBe(1);
    expect(serverBeforeFollowUp.completedQuestions).toBe(1);
    expect(clientBeforeFollowUp.totalQuestions).toBe(
      serverBeforeFollowUp.totalQuestions,
    );
    expect(clientBeforeFollowUp.overallRisk).toBe(
      serverBeforeFollowUp.overallRisk,
    );

    // (b) Providing the text follow-up and key date entry marks both follow-up questions complete on both client and server
    const clientAfterFollowUp = summarizeMatterRiskAssessment({
      answers: answersWithPendingFollowUp,
      followUps: {
        instructionMakesSense: 'Explained commercial rationale with director',
      },
      customKeyDates: [
        {
          id: 'kd-1',
          label: 'Court filing deadline',
          date: '2026-12-01',
        },
      ],
    });
    const serverAfterFollowUp = buildMatterRiskAssessmentSnapshot({
      answers: answersWithPendingFollowUp,
      followUps: {
        instructionMakesSense: 'Explained commercial rationale with director',
      },
      customKeyDates: [
        {
          id: 'kd-1',
          label: 'Court filing deadline',
          date: '2026-12-01',
        },
      ],
      completedById: 'P-000001',
      completedByName: 'Rhian Morgan',
    });

    expect(clientAfterFollowUp.completedQuestions).toBe(3);
    expect(serverAfterFollowUp.completedQuestions).toBe(3);
    expect(clientAfterFollowUp.totalQuestions).toBe(
      serverAfterFollowUp.totalQuestions,
    );

    // (c) Out-of-scope MLR excludes AML-only sections/questions identically on client and server
    const outOfScopeAnswers: Record<string, string> = {};
    for (const sec of MATTER_RISK_SECTIONS) {
      if (sec.amlOnly) continue;
      for (const q of sec.questions) {
        if (q.amlOnly) continue;
        outOfScopeAnswers[q.id] =
          q.id === 'inScopeMlr'
            ? 'No, out of scope'
            : q.options.find((o) => !o.triggersFollowUp)!.label;
      }
    }

    const clientFullOutOfScope = summarizeMatterRiskAssessment({
      answers: outOfScopeAnswers,
      followUps: {},
    });
    const serverFullOutOfScope = buildMatterRiskAssessmentSnapshot({
      answers: outOfScopeAnswers,
      followUps: {},
      completedById: 'P-000001',
      completedByName: 'Rhian Morgan',
    });

    expect(clientFullOutOfScope.totalQuestions).toBe(17);
    expect(serverFullOutOfScope.totalQuestions).toBe(17);
    expect(clientFullOutOfScope.completedQuestions).toBe(17);
    expect(serverFullOutOfScope.completedQuestions).toBe(17);
    expect(clientFullOutOfScope.isComplete).toBe(true);
  });
});
