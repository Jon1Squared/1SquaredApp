# Core RBAC and Matter Access (`@platform/core`)

## Matter-Level Access Control (`canAccessMatter`)

`canAccessMatter` (`core/src/domain/rbac/resolver.ts`) evaluates whether a resolved actor (`ResolvedPermissionSet`) may access a `MatterAccessRecord`:

1. **Unrestricted matters:** If `isStaffMatter`, `hasEthicalWall`, and `restrictedAccessUserIds` (non-empty) are all false, the matter is unrestricted (`true`).
2. **Restricted matters (fail-closed):** If `Boolean(matter.isStaffMatter) || Boolean(matter.hasEthicalWall) || (Array.isArray(matter.restrictedAccessUserIds) && matter.restrictedAccessUserIds.length > 0)` is true, access is denied unless at least one of the following holds:
   - The actor holds `matter:restricted:access` (with MFA when enforced).
   - The actor is a named participant on the matter (`responsiblePartnerId`, `responsibleSolicitorId`, `supervisingPartnerId`, `leadFeeEarnerId`, `originatingSolicitorId`, or included in `teamMemberIds`).
   - The actor is listed in `restrictedAccessUserIds`.

An ethical wall (`hasEthicalWall: true`) with an empty `restrictedAccessUserIds` array therefore fails closed for all non-participants who do not hold `matter:restricted:access`.
