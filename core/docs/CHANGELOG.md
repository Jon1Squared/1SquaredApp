# `@platform/core` Changelog

All notable changes to `@platform/core` and `@platform/core-api` are documented in this file.

## 2026-11-07 — Slice S0-03 (B12, RBAC Registry Additions)

### Added
- **Permission keys (`@platform/core-api`, `core/src/domain/rbac/registry.ts`):**
  - `admin:data_reset` (`requiresMfa: true`, `critical`): granted to `admin` only for non-live data reset and clean-deployment clear operations.
  - `signoff:approve` (`restricted`): granted to `partner`, `managing_partner`, and `admin` for approving or discussing partner sign-off items.
  - `enquiry:anonymise` (`restricted`): granted to `risk_compliance` and `admin` for running enquiry retention anonymisation.
  - `contact:create` and `contact:edit` (`standard`): granted to `fee_earner`, `supervisor`, `partner`, `legal_secretary`, `enquiries_coordinator`, `intake`, `managing_partner`, and `admin` (plus `contact:edit` for `risk_compliance`) for non-employee contact and organisation creation and editing.
- **Ethical walls fail closed (`MatterAccessRecord.hasEthicalWall`, B12):**
  - Added optional `hasEthicalWall?: boolean` to `MatterAccessRecord` (`core/src/domain/rbac/resolver.ts`) and `MatterAccessSubject` (`core/src/domain/document-generation/permissions.ts`).
  - Updated `canAccessMatter` so `Boolean(matter.hasEthicalWall)` marks a matter as restricted even when `isStaffMatter` is `false` and `restrictedAccessUserIds` is empty (`[]`), failing closed unless the actor is a named matter participant or holds `matter:restricted:access`.
