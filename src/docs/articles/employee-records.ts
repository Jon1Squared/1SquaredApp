import type { DocArticle } from '../registry';

export const employeeRecordsArticle: DocArticle = {
  slug: 'employee-records',
  title: 'Employee records, payroll & sensitive HR',
  section: 'people-organisations',
  summary:
    'How 1Squared separates core employment, HR-restricted terms, payroll and benefits, and special-category HR information, and how audited per-person payroll loading protects confidentiality.',
  updated: '2026-11-19',
  body: `
1Squared stores colleagues alongside external contacts in \`public.people\` with dedicated PostgreSQL tables for employment (\`public.employee_employment_records\`) and payroll/special-category HR (\`public.employee_sensitive_records\`, protected with \`ON DELETE RESTRICT\`).

## Permission tiers on employee records

1. **Core employment (\`employee:view_core\`, \`employee:edit_core\`)**: Role type, department, office, reporting lines, and systems access. Line managers receive scoped \`employee:view_core\` and \`employee:edit_core\` for their direct reports through the \`rbac.relationshipGrants.is_line_manager_of\` relationship rule.
2. **HR-restricted sections (\`employee:hr_restricted\`)**: Contract terms, continuous service and probation tracking, right-to-work checks, vetting, and inline emergency contacts.
3. **Payroll and benefits (\`employee:payroll\`)**: External payroll reference, National Insurance number, bank account details, starter declaration, student loan plan, and pension auto-enrolment status.
4. **Special-category HR (\`employee:sensitive\`)**: Reasonable adjustments and optional diversity monitoring answers.

## Audited on-demand payroll & sensitive HR loading

- **Omitted from bulk snapshots**: General application snapshots (\`getAppSnapshot\`, including \`currentUser\`, \`effectiveWorkPerson\`, and \`employees\`), registers workspace payloads (\`listRegistersWorkspaceDataRecord\`), person saves (\`savePersonRecord\`), and override updates (\`updatePersonPermissionOverrides\`) omit both \`payroll\` and \`sensitive\` sections for **all** users—including administrators and payroll holders—and failed or denied person saves return \`person: null\` rather than the stored record. \`savePersonRecord\` also strips \`permissionOverrides\` and \`entraObjectId\` from success returns unless the caller holds \`rbac:manage_user_overrides\` or \`rbac:manage_config\`.
- **Explicit audited reveal**: Opening **Reveal payroll details** on an employee profile calls \`revealEmployeePayrollAction\` (default \`masked\` mode, returning server-masked NI and bank account numbers rather than raw values), while switching to the **Payroll & benefits** sub-tab when editing an employee loads full values once via \`mode: 'full'\` and unmasking in the form is UI-only without duplicating audits. Both paths call \`getEmployeeDetailsForUser\` with \`logViewPayroll: true\`, returning payroll only after the \`view-payroll\` audit entry commits in the same PostgreSQL transaction (and writing no \`view-payroll\` audit row when a person has no employment or stored payroll record).
- **Safe non-payroll edits & blank compliance defaults (\`R512\`)**: Editing an employee’s contact details or non-payroll employment fields without opening and editing **Payroll & benefits** leaves existing stored payroll fields untouched in PostgreSQL rather than overwriting them with blank values. New employees created through the form or \`savePersonRecord\` without an explicit employment payload start with unrecorded compliance, vetting, payroll, and fee-earner rate fields (\`null\`, empty, or \`Not recorded\`) rather than fabricated defaults.

For role configuration, email identity-change MFA rules, and leaver transfers, see [Sign-in, roles & permissions (RBAC) and MFA](/docs/authentication-rbac-and-mfa) and [Leavers and record reassignment](/docs/leavers-and-reassignment).
`,
};
