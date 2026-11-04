import { resolveEmployeeRoles } from '@/domain/homeConfig';
import { isUserTeamLeadFor } from '@/domain/tasks';
import { canPersonAccessMatter } from './rbacRuntime';
import type { Matter, OrgStructureCatalogue, Person, Team } from '@/domain/types';

export interface ConflictReviewConfigInput {
  assigneeTeamKey?: string | null;
  assigneeRoleKey?: string | null;
}

export interface ConflictReviewStoreSlice {
  people: Person[];
  teams: Team[];
  orgStructure?: OrgStructureCatalogue;
}

/**
 * Resolves the conflict review team from tenant configuration using stable
 * team `id` or organisation team `id`/`code` only (never display names).
 */
export function resolveConflictReviewTeam(
  store: Pick<ConflictReviewStoreSlice, 'teams' | 'orgStructure'>,
  cfg: ConflictReviewConfigInput | undefined | null,
): Team | undefined {
  const key = cfg?.assigneeTeamKey?.trim();
  if (!key) return undefined;

  const direct = store.teams.find((tm: Team) => tm.active && tm.id === key);
  if (direct) return direct;

  const matchedOrgTeam = store.orgStructure?.teamsOrPracticeGroups?.find(
    (ot) => ot.active && (ot.id === key || ot.code === key),
  );
  if (!matchedOrgTeam) return undefined;

  return store.teams.find(
    (tm: Team) =>
      tm.active &&
      (tm.id === matchedOrgTeam.id || tm.id === matchedOrgTeam.code),
  );
}

function personMatchesConfiguredRole(
  person: Person,
  roleKey: string,
  store: Pick<ConflictReviewStoreSlice, 'teams'>,
  rolesByPersonId?: Record<string, readonly string[]>,
): boolean {
  if (person.employeeRoleId === roleKey) return true;
  const resolvedRoles =
    rolesByPersonId?.[person.id] ?? resolveEmployeeRoles(person, store.teams);
  return resolvedRoles.includes(roleKey);
}

/**
 * Resolves the suggested conflict reviewer for UI governance suggestions (`getAppSnapshot`).
 * Uses the same stable `conflictReview` team and role resolution as task routing, with
 * no display-name matching and no hard-coded role fallbacks.
 */
export function resolveSuggestedConflictReviewer(
  store: Pick<ConflictReviewStoreSlice, 'teams' | 'orgStructure'>,
  cfg: ConflictReviewConfigInput | undefined | null,
  rolesByPersonId: Record<string, readonly string[]>,
  employees: readonly Person[],
): Person | null {
  const configuredTeamKey = cfg?.assigneeTeamKey?.trim() || null;
  const configuredRoleKey = cfg?.assigneeRoleKey?.trim() || null;
  const team = resolveConflictReviewTeam(store, cfg);

  // If a team key was configured but does not match any active team's id/code, do not match by name or fallback.
  if (configuredTeamKey && !team) {
    return null;
  }

  const sortByTeamLead = (list: Person[]): Person[] => {
    if (!team) return list;
    return [...list].sort((a: Person, b: Person) => {
      const aLead = isUserTeamLeadFor(a.id, team.id, store.teams) ? 0 : 1;
      const bLead = isUserTeamLeadFor(b.id, team.id, store.teams) ? 0 : 1;
      return aLead - bLead || a.id.localeCompare(b.id);
    });
  };

  if (configuredRoleKey) {
    const roleMatches = employees.filter((p) =>
      personMatchesConfiguredRole(p, configuredRoleKey, store, rolesByPersonId),
    );
    if (team) {
      const inTeamMatches = sortByTeamLead(
        roleMatches.filter((p) => team.memberIds.includes(p.id)),
      );
      return inTeamMatches[0] ?? null;
    }
    return sortByTeamLead(roleMatches)[0] ?? null;
  }

  if (team) {
    const teamMembers = sortByTeamLead(
      employees.filter((p) => team.memberIds.includes(p.id)),
    );
    return teamMembers[0] ?? null;
  }

  return null;
}

/**
 * Resolves the conflict review team and permitted assignee for a referred matter's review task.
 */
export function resolveConflictReviewTaskRouting(
  store: ConflictReviewStoreSlice,
  cfg: ConflictReviewConfigInput | undefined | null,
  matter: Matter,
): { team: Team | undefined; assigneeId: string | null } {
  const team = resolveConflictReviewTeam(store, cfg);
  if (!team) {
    return { team: undefined, assigneeId: null };
  }

  const configuredRoleKey = cfg?.assigneeRoleKey?.trim() || null;
  const teamCandidates = store.people
    .filter(
      (p: Person) =>
        p.isEmployee &&
        !p.mergedIntoId &&
        team.memberIds.includes(p.id),
    )
    .filter((p: Person) =>
      configuredRoleKey
        ? personMatchesConfiguredRole(p, configuredRoleKey, store)
        : true,
    )
    .filter((p: Person) =>
      canPersonAccessMatter(matter, p.id, p, {
        allPeople: store.people,
        teams: store.teams,
      }),
    );

  teamCandidates.sort((a: Person, b: Person) => {
    const aLead = isUserTeamLeadFor(a.id, team.id, store.teams) ? 0 : 1;
    const bLead = isUserTeamLeadFor(b.id, team.id, store.teams) ? 0 : 1;
    return aLead - bLead || a.id.localeCompare(b.id);
  });

  return {
    team,
    assigneeId: teamCandidates[0]?.id ?? null,
  };
}
