## Summary

<!-- Briefly describe what this pull request changes and why. -->

## Change Classification (Section 14)

- **Class:** <!-- Core feature | Core extension point | Configuration option | Client extension | Client configuration | Infrastructure -->
- **Hosting models (`single_tenant` and `multi_tenant`):** <!-- State how this change works in both hosting models. -->
- **Migration & rollback steps:** <!-- Describe any database migration, configuration migration, or rollback steps (or state "None"). -->

## Definition of Done Checklist

- [ ] Classified correctly, and no client-specific logic is in the core.
- [ ] Dependencies point one way (extensions to core API).
- [ ] Works in both hosting models (single-tenant and multi-tenant).
- [ ] All data access is tenant-scoped and isolation tests pass.
- [ ] No secrets, client names or client data in code, logs or test fixtures.
- [ ] Configuration changes have schema, default and validation, and are backward compatible.
- [ ] Extension API changes are versioned, contract-tested and deprecation-noted.
- [ ] Migrations are backward compatible and reversible.
- [ ] Tests added and CI passes, including security scans.
- [ ] Documentation and release notes updated.
- [ ] Help & documentation updated.
- [ ] Cost and performance impact considered.
- [ ] Any exception to this standard is recorded as a decision record and approved.
