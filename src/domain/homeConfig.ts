import {
  ChoiceValue,
  HomePagesConfig,
  HomeRoleKey,
  PanelCategory,
  PanelId,
  PanelPlacement,
  Person,
  RoleHomeConfig,
  Team,
} from './types';
import {
  getDefaultTenantRbacConfig,
  resolveActiveTenantIdForRbac,
  resolvePermissions,
  resolvePersonAuthoritativeRoles,
} from './rbac';

export interface PanelDefinition {
  id: PanelId;
  name: string;
  sourceLabel: string;
  category: PanelCategory;
  description: string;
}

export interface HeadlineCardDefinition {
  id: string;
  label: string;
  source: '1Squared' | 'PMS' | 'Both';
  defaultRoles: HomeRoleKey[];
}

export const PANEL_DEFINITIONS: PanelDefinition[] = [
  // Tasks, enquiries & daily work
  {
    id: 'to_do',
    name: 'To Do — tasks & key dates (overdue, today & tomorrow)',
    sourceLabel: '1Squared Tasks, Matter key dates & Enquiry deadlines · grouped by due date',
    category: 'Tasks, enquiries & daily work',
    description:
      'Combined view of open tasks and key dates organised by Overdue, Due today, and Due tomorrow.',
  },
  {
    id: 'my_tasks_today',
    name: "My tasks — due today & overdue",
    sourceLabel: '1Squared Tasks · sorted by priority then due time',
    category: 'Tasks, enquiries & daily work',
    description: 'Tasks assigned to the user due today or overdue, plus upcoming this week.',
  },
  {
    id: 'my_enquiries_awaiting_contact',
    name: 'My enquiries awaiting first contact',
    sourceLabel: '1Squared Enquiries · SLA countdown from Admin › Enquiries',
    category: 'Tasks, enquiries & daily work',
    description: 'Enquiries assigned to the user awaiting first contact or follow-up.',
  },
  {
    id: 'my_active_matters',
    name: 'My active matters — at a glance',
    sourceLabel: '1Squared Matters + PMS financials (`v_matter_financials`)',
    category: 'Tasks, enquiries & daily work',
    description: 'Open matters where the user is lead fee earner or team member, with PMS WIP and debt.',
  },
  {
    id: 'my_time_and_wip',
    name: 'My time & WIP',
    sourceLabel: 'PMS `time_entries` + `v_fee_earner_performance` · read-only',
    category: 'Tasks, enquiries & daily work',
    description: 'Read-only chargeable hours recorded in PMS this week, October vs target, and unbilled WIP.',
  },
  {
    id: 'key_dates_and_deadlines',
    name: 'Key dates & deadlines (next 14 days)',
    sourceLabel: '1Squared Matter milestones, key dates & high-priority tasks',
    category: 'Tasks, enquiries & daily work',
    description: 'Upcoming completions, tribunal/court deadlines, and matter milestones.',
  },
  {
    id: 'waiting_on_client',
    name: 'Waiting on client / third party',
    sourceLabel: '1Squared Tasks with status Waiting + Onboarding checks',
    category: 'Tasks, enquiries & daily work',
    description: 'Tasks in Waiting status and pending onboarding items.',
  },
  {
    id: 'team_enquiries_and_unassigned_tasks',
    name: 'Team queue — unassigned enquiries & tasks',
    sourceLabel: '1Squared Teams · one click to claim into My work',
    category: 'Tasks, enquiries & daily work',
    description: 'Unassigned enquiries and tasks in the user’s teams ready to claim.',
  },

  // Intake & conversion
  {
    id: 'quick_enquiry_capture',
    name: 'Quick enquiry capture',
    sourceLabel: '1Squared Enquiries · inline intake form with live duplicate check',
    category: 'Intake & conversion',
    description: 'Inline phone/email/web intake form with duplicate check and automatic team routing.',
  },
  {
    id: 'callback_sla_queue',
    name: 'Callback SLA queue — all open enquiries',
    sourceLabel: '1Squared Enquiries · ordered by first-contact deadline',
    category: 'Intake & conversion',
    description: 'Every open enquiry ordered by SLA countdown.',
  },
  {
    id: 'unassigned_enquiries',
    name: 'Unassigned enquiries — needs routing or owner',
    sourceLabel: '1Squared Enquiries · claim or assign to a fee earner in one click',
    category: 'Intake & conversion',
    description: 'Enquiries in team queues without an individual fee earner owner.',
  },
  {
    id: 'awaiting_fee_earner_response',
    name: 'Assigned — awaiting fee earner first contact',
    sourceLabel: '1Squared Enquiries · chase or reassign before SLA breach',
    category: 'Intake & conversion',
    description: 'Assigned enquiries where first contact has not yet been logged.',
  },
  {
    id: 'todays_outcomes_and_conversion',
    name: "This month's outcomes & conversion",
    sourceLabel: '1Squared Enquiries · October 2026',
    category: 'Intake & conversion',
    description: 'Received, converted, in-progress, declined, and non-responsive enquiries.',
  },
  {
    id: 'referral_sources_this_month',
    name: 'Enquiry channels & referral sources',
    sourceLabel: '1Squared Enquiries + Referrer contacts · October 2026',
    category: 'Intake & conversion',
    description: 'Breakdown of enquiry origins and named referrers this month.',
  },

  // Secretarial & matter support
  {
    id: 'team_tasks_for_supported_fee_earners',
    name: 'Team task queue — for supported fee earners',
    sourceLabel: '1Squared Tasks · take ownership or complete on behalf of the team',
    category: 'Secretarial & matter support',
    description: 'Tasks in the user’s queue and delegated from supported fee earners and partners.',
  },
  {
    id: 'documents_and_correspondence_queue',
    name: 'Documents & correspondence queue',
    sourceLabel: '1Squared Tasks (`Document` / `Admin`) + auto-generated letters',
    category: 'Secretarial & matter support',
    description: 'Engagement letters, client care packs, searches, and non-engagement letters to prepare.',
  },
  {
    id: 'matter_openings_in_progress',
    name: 'Matter openings — onboarding checklist',
    sourceLabel: '1Squared Matters · conflict check, AML/CDD, engagement letter, retainer',
    category: 'Secretarial & matter support',
    description: 'Four-step onboarding tracker (Conflict, AML/CDD, Engagement letter, Retainer) per matter.',
  },
  {
    id: 'upcoming_completions_and_filings',
    name: 'Upcoming completions, filings & key dates',
    sourceLabel: '1Squared Matters · supported fee earners',
    category: 'Secretarial & matter support',
    description: 'Completions, filings, and deadlines across supported fee earners.',
  },
  {
    id: 'disbursements_and_invoices_to_log',
    name: 'Unbilled disbursements on team matters',
    sourceLabel: 'PMS `disbursements` · read-only',
    category: 'Secretarial & matter support',
    description: 'Unbilled counsel fees, search fees, and Land Registry charges on supported matters.',
  },

  // Partner oversight
  {
    id: 'matters_needing_partner_attention',
    name: 'Matters needing partner attention',
    sourceLabel: '1Squared Matters + PMS financials · exceptions & risks',
    category: 'Partner oversight',
    description: 'Supervised matters breaching fee estimate, carrying 60+ day debt, high risk, or pending AML.',
  },
  {
    id: 'sign_offs_and_approvals',
    name: 'Sign-offs & approvals waiting on you',
    sourceLabel: '1Squared Tasks & Matter onboarding · one-click approve or return',
    category: 'Partner oversight',
    description: 'Write-offs, high-risk matter openings, and undertakings awaiting partner approval.',
  },
  {
    id: 'team_workload_and_utilisation',
    name: 'Team workload & utilisation',
    sourceLabel: 'PMS `v_fee_earner_performance` + 1Squared open task/matter counts',
    category: 'Partner oversight',
    description: 'Fee earner open matters, tasks, October hours, YTD target %, and unbilled WIP.',
  },
  {
    id: 'wip_ready_to_bill_and_aged_debt',
    name: 'Unbilled WIP & overdue debt on my matters',
    sourceLabel: 'PMS `v_matter_financials` + `v_invoice_balances` · read-only',
    category: 'Partner oversight',
    description: 'Supervised matters ready to bill and overdue invoices needing partner escalation.',
  },
  {
    id: 'enquiries_and_conversion_by_practice_area',
    name: 'Enquiries & conversion — my practice area',
    sourceLabel: '1Squared Enquiries · October 2026',
    category: 'Partner oversight',
    description: 'Practice area intake funnel, conversion rate, and unassigned enquiry alert.',
  },
  {
    id: 'key_client_and_referrer_touchpoints',
    name: 'Key clients & referrers — touchpoints due',
    sourceLabel: '1Squared Organisations & People (`relationshipPartnerId`) + PMS exposure',
    category: 'Partner oversight',
    description: 'Key client and referrer relationships where a partner review or touchpoint is due.',
  },

  // Finance & credit control
  {
    id: 'aged_debt_by_age_band',
    name: 'Aged debt by band — firm-wide',
    sourceLabel: 'PMS `v_invoice_balances` · £49,130.22 across 11 unpaid / part-paid bills',
    category: 'Finance & credit control',
    description: 'Stacked breakdown of firm-wide debt across Not yet due, 1–30d, 31–60d, 61–90d, and 90+d.',
  },
  {
    id: 'overdue_invoices_worklist',
    name: 'Overdue invoices — credit control worklist',
    sourceLabel: 'PMS `v_invoice_balances` + 1Squared chase tasks · ordered by days overdue',
    category: 'Finance & credit control',
    description: 'Actionable credit control queue with client billing contact, credit limit status, and chase actions.',
  },
  {
    id: 'wip_ready_to_bill',
    name: 'Unbilled WIP — ready to bill by matter',
    sourceLabel: 'PMS `v_matter_financials` + `fee_estimates` · prompt fee earners in one click',
    category: 'Finance & credit control',
    description: 'Matters with unbilled WIP and disbursements, estimate health, and one-click Request bill.',
  },
  {
    id: 'client_account_reconciliation_and_exceptions',
    name: 'Client account balances — SRA Accounts Rules monitor',
    sourceLabel: 'PMS `client_account` ledger · check for residual or stagnant balances',
    category: 'Finance & credit control',
    description: 'Client monies held by matter, last movement date, and SRA rule 2.5 residual balance checks.',
  },
  {
    id: 'disbursements_awaiting_billing',
    name: 'Unbilled disbursements — awaiting billing',
    sourceLabel: 'PMS `disbursements` · £1,182.00 net (£1,416.00 inc VAT)',
    category: 'Finance & credit control',
    description: 'Unbilled supplier disbursements incurred on client matters.',
  },
  {
    id: 'cash_collection_vs_target',
    name: 'Cash collection & billing — October 2026',
    sourceLabel: 'PMS `payments` + `invoices` · month-to-date',
    category: 'Finance & credit control',
    description: 'October cash receipts, fees billed, and credit notes issued vs target.',
  },

  // Risk & compliance
  {
    id: 'aml_and_cdd_queue',
    name: 'AML & Customer Due Diligence queue',
    sourceLabel: '1Squared Matters, Organisations & People · MLR 2017 checks',
    category: 'Risk & compliance',
    description: 'Matters and clients with pending ID&V, source of funds, or source of wealth checks.',
  },
  {
    id: 'conflict_checks_awaiting_decision',
    name: 'Conflict checks — awaiting MLRO / COLP decision',
    sourceLabel: '1Squared Matters + Enquiries (`otherPartiesNamed`)',
    category: 'Risk & compliance',
    description: 'Matters and new enquiries with pending conflict searches or potential party matches.',
  },
  {
    id: 'high_risk_matters_and_pep_register',
    name: 'High-risk matters, PEPs & sanctions watch',
    sourceLabel: '1Squared Matters (`riskRatingId = High`) + PMS client account exposure',
    category: 'Risk & compliance',
    description: 'Register of high-risk matters, enhanced due diligence requirements, and client monies.',
  },
  {
    id: 'undertakings_and_file_reviews',
    name: 'Undertakings & periodic file reviews',
    sourceLabel: '1Squared Matters & Compliance tasks',
    category: 'Risk & compliance',
    description: 'Open solicitor undertakings and periodic Lexcel/CQS file review schedule.',
  },
  {
    id: 'complaints_incidents_and_breaches',
    name: 'Complaints, SRA breaches & residual balances',
    sourceLabel: 'COLP / COFA register + PMS client account monitor',
    category: 'Risk & compliance',
    description: 'Open client complaints, material SRA breaches, and residual client balance watch.',
  },
  {
    id: 'overdue_compliance_tasks_by_team',
    name: 'Overdue compliance & onboarding tasks by team',
    sourceLabel: '1Squared Tasks (`Conflict check`, `AML / ID verification`, `Onboarding`)',
    category: 'Risk & compliance',
    description: 'Team breakdown of overdue compliance and onboarding tasks with one-click Remind team lead.',
  },

  // Firm-wide executive
  {
    id: 'firm_financial_pulse',
    name: 'Firm financial pulse — 2026 year to date',
    sourceLabel: 'PMS `invoices`, `payments`, `v_matter_financials` · net of credit notes · ex VAT',
    category: 'Firm-wide executive',
    description: 'Monthly fees billed Jan–Oct 2026 plus lockup (WIP + debt) and collection rate.',
  },
  {
    id: 'performance_by_department',
    name: 'Performance by practice area',
    sourceLabel: 'PMS `v_matter_financials` + `v_fee_earner_performance` · 2026 YTD',
    category: 'Firm-wide executive',
    description: 'Open matters, billed YTD, unbilled WIP, outstanding/overdue debt, and October hours by department.',
  },
  {
    id: 'utilisation_and_realisation_by_grade',
    name: 'Fee earner utilisation & billing',
    sourceLabel: 'PMS `v_fee_earner_performance` · annual target 1,200 chargeable hrs',
    category: 'Firm-wide executive',
    description: 'Firm-wide fee earner chargeable hours, % of annual target, billed value, WIP, and write-offs.',
  },
  {
    id: 'enquiries_conversion_and_pipeline',
    name: 'New business — enquiries, conversion & SLA health',
    sourceLabel: '1Squared Enquiries · October 2026',
    category: 'Firm-wide executive',
    description: 'Firm-wide intake volume, conversion rate, SLA compliance, and top referral sources.',
  },
  {
    id: 'top_clients_and_concentration',
    name: 'Top clients by fees billed & total exposure',
    sourceLabel: 'PMS `v_client_financials` · revenue concentration & credit risk',
    category: 'Firm-wide executive',
    description: 'Top clients ranked by fees billed, share of firm revenue, WIP, debt, and credit limit usage.',
  },
  {
    id: 'firm_risk_and_exceptions_register',
    name: 'Exceptions — financial, compliance & operational',
    sourceLabel: 'Combined 1Squared + PMS exception feed',
    category: 'Firm-wide executive',
    description: 'Executive summary of 90+ day debt, budget overruns, AML blocks, and SLA breaches.',
  },
];

export const HEADLINE_CARD_DEFINITIONS: HeadlineCardDefinition[] = [
  // Fee Earner (01)
  { id: 'fe_tasks_due', label: 'Tasks due / overdue', source: '1Squared', defaultRoles: ['fee_earner'] },
  { id: 'fe_enquiries_contact', label: 'Enquiries to contact', source: '1Squared', defaultRoles: ['fee_earner'] },
  { id: 'fe_active_matters', label: 'My active matters', source: '1Squared', defaultRoles: ['fee_earner'] },
  { id: 'fe_hours_month', label: 'Chargeable hrs (Oct)', source: 'PMS', defaultRoles: ['fee_earner'] },
  { id: 'fe_unbilled_wip', label: 'My unbilled WIP', source: 'PMS', defaultRoles: ['fee_earner'] },

  // Partner (02)
  { id: 'pt_supervised_matters', label: 'Supervised matters', source: '1Squared', defaultRoles: ['partner'] },
  { id: 'pt_team_wip', label: 'Team unbilled WIP', source: 'PMS', defaultRoles: ['partner'] },
  { id: 'pt_overdue_debt', label: 'Overdue client debt', source: 'PMS', defaultRoles: ['partner'] },
  { id: 'pt_sign_offs', label: 'Sign-offs waiting', source: '1Squared', defaultRoles: ['partner'] },
  { id: 'pt_enquiries_month', label: 'Dept enquiries (Oct)', source: '1Squared', defaultRoles: ['partner'] },

  // Legal Secretary (03)
  { id: 'ls_tasks_queue', label: 'Tasks in my queue', source: '1Squared', defaultRoles: ['legal_secretary'] },
  { id: 'ls_letters_docs', label: 'Letters & docs to prepare', source: '1Squared', defaultRoles: ['legal_secretary'] },
  { id: 'ls_matter_openings', label: 'Matter openings in progress', source: '1Squared', defaultRoles: ['legal_secretary'] },
  { id: 'ls_completions_7d', label: 'Completions next 7 days', source: '1Squared', defaultRoles: ['legal_secretary'] },
  { id: 'ls_unbilled_disb', label: 'Unbilled disbursements', source: 'PMS', defaultRoles: ['legal_secretary'] },

  // Enquiries Coordinator (04)
  { id: 'ec_callbacks_due', label: 'Callbacks due today', source: '1Squared', defaultRoles: ['enquiries_coordinator'] },
  { id: 'ec_unassigned', label: 'Unassigned enquiries', source: '1Squared', defaultRoles: ['enquiries_coordinator'] },
  { id: 'ec_awaiting_fe', label: 'Awaiting fee earner contact', source: '1Squared', defaultRoles: ['enquiries_coordinator'] },
  { id: 'ec_converted_month', label: 'Converted in October', source: '1Squared', defaultRoles: ['enquiries_coordinator'] },
  { id: 'ec_no_response', label: '3+ attempts — no response', source: '1Squared', defaultRoles: ['enquiries_coordinator'] },

  // Finance / Credit Control (05)
  { id: 'fin_total_debt', label: 'Total outstanding debt', source: 'PMS', defaultRoles: ['finance'] },
  { id: 'fin_overdue_debt', label: 'Overdue debt', source: 'PMS', defaultRoles: ['finance'] },
  { id: 'fin_unbilled_wip', label: 'Unbilled WIP (firm)', source: 'PMS', defaultRoles: ['finance'] },
  { id: 'fin_unbilled_disb', label: 'Unbilled disbursements', source: 'PMS', defaultRoles: ['finance'] },
  { id: 'fin_client_account', label: 'Client account held', source: 'PMS', defaultRoles: ['finance'] },

  // Risk & Compliance (06)
  { id: 'rc_aml_pending', label: 'AML / ID checks pending', source: '1Squared', defaultRoles: ['risk_compliance'] },
  { id: 'rc_conflicts_pending', label: 'Conflict checks awaiting sign-off', source: '1Squared', defaultRoles: ['risk_compliance'] },
  { id: 'rc_high_risk_matters', label: 'High-risk open matters', source: '1Squared', defaultRoles: ['risk_compliance'] },
  { id: 'rc_overdue_tasks', label: 'Overdue compliance tasks', source: '1Squared', defaultRoles: ['risk_compliance'] },
  { id: 'rc_sra_breaches', label: 'Open SRA breaches / complaints', source: '1Squared', defaultRoles: ['risk_compliance'] },

  // Managing Partner (07)
  { id: 'mp_fees_ytd', label: 'Fees billed YTD (2026)', source: 'PMS', defaultRoles: ['managing_partner', 'admin'] },
  { id: 'mp_cash_month', label: 'Cash received (Oct)', source: 'PMS', defaultRoles: ['managing_partner', 'admin'] },
  { id: 'mp_firm_wip', label: 'Firm unbilled WIP', source: 'PMS', defaultRoles: ['managing_partner', 'admin'] },
  { id: 'mp_total_debt', label: 'Total client debt', source: 'PMS', defaultRoles: ['managing_partner', 'admin'] },
  { id: 'mp_open_matters', label: 'Open matters & conversion', source: 'Both', defaultRoles: ['managing_partner', 'admin'] },
];

export const EMPLOYEE_ROLE_TO_HOME_ROLE_KEY: Record<string, string> = {
  'employee_role.fee_earner': 'fee_earner',
  'employee_role.partner': 'partner',
  'employee_role.support_staff': 'legal_secretary',
  'employee_role.business_development': 'enquiries_coordinator',
  'employee_role.finance': 'finance',
  'employee_role.risk_and_compliance': 'risk_compliance',
  'employee_role.practice_manager': 'managing_partner',
  'employee_role.system_administrator': 'admin',
};

export const HOME_ROLE_KEY_TO_EMPLOYEE_ROLE_ID: Record<string, string> = {
  fee_earner: 'employee_role.fee_earner',
  partner: 'employee_role.partner',
  legal_secretary: 'employee_role.support_staff',
  enquiries_coordinator: 'employee_role.business_development',
  finance: 'employee_role.finance',
  risk_compliance: 'employee_role.risk_and_compliance',
  managing_partner: 'employee_role.practice_manager',
  admin: 'employee_role.system_administrator',
};

export function createDefaultRoleConfigs(): RoleHomeConfig[] {
  return [
    {
      key: 'fee_earner',
      employeeRoleId: 'employee_role.fee_earner',
      label: 'Fee earner',
      shortLabel: 'Fee earner',
      purpose: "Today's tasks, enquiries to call back, active matters, key dates and personal WIP.",
      designNumber: '01',
      demoUserEmail: 'felicity.fee-earner@notalawfirm.example',
      headlineCardIds: ['fe_tasks_due', 'fe_enquiries_contact', 'fe_active_matters', 'fe_hours_month', 'fe_unbilled_wip'],
      primaryPanels: [
        'to_do',
        'my_enquiries_awaiting_contact',
        'my_active_matters',
        'team_enquiries_and_unassigned_tasks',
      ],
      summaryPanels: ['my_time_and_wip', 'waiting_on_client'],
      isBuiltIn: true,
    },
    {
      key: 'partner',
      employeeRoleId: 'employee_role.partner',
      label: 'Partner',
      shortLabel: 'Partner',
      purpose: 'Matters needing attention, sign-offs, team capacity, WIP to bill, aged debt and key clients.',
      designNumber: '02',
      demoUserEmail: 'patrick.partner@notalawfirm.example',
      headlineCardIds: ['pt_supervised_matters', 'pt_team_wip', 'pt_overdue_debt', 'pt_sign_offs', 'pt_enquiries_month'],
      primaryPanels: [
        'matters_needing_partner_attention',
        'sign_offs_and_approvals',
        'team_workload_and_utilisation',
        'wip_ready_to_bill_and_aged_debt',
      ],
      summaryPanels: [
        'to_do',
        'my_enquiries_awaiting_contact',
        'enquiries_and_conversion_by_practice_area',
        'key_client_and_referrer_touchpoints',
      ],
      isBuiltIn: true,
    },
    {
      key: 'legal_secretary',
      employeeRoleId: 'employee_role.support_staff',
      label: 'Support staff',
      shortLabel: 'Support staff',
      purpose: 'Delegated tasks across supported fee earners, letters to send, matter openings and completions.',
      designNumber: '03',
      demoUserEmail: 'simone.secretary@notalawfirm.example',
      headlineCardIds: ['ls_tasks_queue', 'ls_letters_docs', 'ls_matter_openings', 'ls_completions_7d', 'ls_unbilled_disb'],
      primaryPanels: [
        'team_tasks_for_supported_fee_earners',
        'documents_and_correspondence_queue',
        'matter_openings_in_progress',
      ],
      summaryPanels: [
        'to_do',
        'waiting_on_client',
        'upcoming_completions_and_filings',
        'disbursements_and_invoices_to_log',
      ],
      isBuiltIn: true,
    },
    {
      key: 'enquiries_coordinator',
      employeeRoleId: 'employee_role.business_development',
      label: 'Business development',
      shortLabel: 'Business development',
      purpose: 'Inline enquiry capture, live callback SLA countdowns, unassigned queue and conversion funnel.',
      designNumber: '04',
      demoUserEmail: 'ethel.enquiries@notalawfirm.example',
      headlineCardIds: ['ec_callbacks_due', 'ec_unassigned', 'ec_awaiting_fe', 'ec_converted_month', 'ec_no_response'],
      primaryPanels: [
        'quick_enquiry_capture',
        'callback_sla_queue',
        'unassigned_enquiries',
        'awaiting_fee_earner_response',
      ],
      summaryPanels: [
        'to_do',
        'team_enquiries_and_unassigned_tasks',
        'todays_outcomes_and_conversion',
        'referral_sources_this_month',
      ],
      isBuiltIn: true,
    },
    {
      key: 'finance',
      employeeRoleId: 'employee_role.finance',
      label: 'Finance',
      shortLabel: 'Finance',
      purpose: 'Aged debt bands, credit control chase queue, WIP ready to bill and client account ledger.',
      designNumber: '05',
      demoUserEmail: 'frank.finance@notalawfirm.example',
      headlineCardIds: ['fin_total_debt', 'fin_overdue_debt', 'fin_unbilled_wip', 'fin_unbilled_disb', 'fin_client_account'],
      primaryPanels: ['aged_debt_by_age_band', 'overdue_invoices_worklist', 'wip_ready_to_bill'],
      summaryPanels: [
        'to_do',
        'client_account_reconciliation_and_exceptions',
        'disbursements_awaiting_billing',
        'cash_collection_vs_target',
      ],
      isBuiltIn: true,
    },
    {
      key: 'risk_compliance',
      employeeRoleId: 'employee_role.risk_and_compliance',
      label: 'Risk and compliance',
      shortLabel: 'Risk & compliance',
      purpose: 'AML & CDD queue, conflict checks awaiting decision, high-risk matters and undertakings.',
      designNumber: '06',
      demoUserEmail: 'rita.risk@notalawfirm.example',
      headlineCardIds: ['rc_aml_pending', 'rc_conflicts_pending', 'rc_high_risk_matters', 'rc_overdue_tasks', 'rc_sra_breaches'],
      primaryPanels: [
        'aml_and_cdd_queue',
        'conflict_checks_awaiting_decision',
        'high_risk_matters_and_pep_register',
      ],
      summaryPanels: [
        'to_do',
        'matter_openings_in_progress',
        'undertakings_and_file_reviews',
        'complaints_incidents_and_breaches',
        'overdue_compliance_tasks_by_team',
      ],
      isBuiltIn: true,
    },
    {
      key: 'managing_partner',
      employeeRoleId: 'employee_role.practice_manager',
      label: 'Practice manager',
      shortLabel: 'Practice manager',
      purpose: 'Firm-wide billing vs budget, lockup, departmental performance, conversion and client concentration.',
      designNumber: '07',
      demoUserEmail: 'martha.managing-partner@notalawfirm.example',
      headlineCardIds: ['mp_fees_ytd', 'mp_cash_month', 'mp_firm_wip', 'mp_total_debt', 'mp_open_matters'],
      primaryPanels: [
        'firm_financial_pulse',
        'performance_by_department',
        'utilisation_and_realisation_by_grade',
      ],
      summaryPanels: [
        'sign_offs_and_approvals',
        'aged_debt_by_age_band',
        'enquiries_conversion_and_pipeline',
        'top_clients_and_concentration',
        'firm_risk_and_exceptions_register',
      ],
      isBuiltIn: true,
    },
    {
      key: 'admin',
      employeeRoleId: 'employee_role.system_administrator',
      label: 'System administrator',
      shortLabel: 'System administrator',
      purpose: 'System configuration, role Home page layout management, and full executive overview.',
      designNumber: '00',
      demoUserEmail: 'adam.admin@notalawfirm.example',
      headlineCardIds: ['mp_fees_ytd', 'mp_cash_month', 'mp_firm_wip', 'mp_total_debt', 'mp_open_matters'],
      primaryPanels: [
        'firm_financial_pulse',
        'performance_by_department',
        'utilisation_and_realisation_by_grade',
      ],
      summaryPanels: [
        'sign_offs_and_approvals',
        'aged_debt_by_age_band',
        'enquiries_conversion_and_pipeline',
        'top_clients_and_concentration',
        'firm_risk_and_exceptions_register',
      ],
      isBuiltIn: true,
    },
  ];
}

/**
 * Synchronises `homePagesConfig.roles` with the active `employee_role` items
 * in the People section of the Taxonomy (`values.filter(v => v.listKey === 'employee_role')`).
 * Also removes any deprecated test roles (`test_role`).
 */
export function syncHomeRolesWithEmployeeRoles(
  roles: RoleHomeConfig[],
  values: ChoiceValue[],
): RoleHomeConfig[] {
  const defaultRoles = createDefaultRoleConfigs();
  const cleanedRoles = (roles ?? []).filter((r) => r.key !== 'test_role');
  const employeeRoleValues = values
    .filter((v) => v.listKey === 'employee_role' && v.active)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (employeeRoleValues.length === 0) {
    return cleanedRoles.length > 0 ? cleanedRoles : defaultRoles;
  }

  const matchedKeys = new Set<string>();
  const result: RoleHomeConfig[] = [];

  // First keep existing roles that match an active `employee_role` item, updating their label/employeeRoleId
  for (const existing of cleanedRoles) {
    const linkedId = existing.employeeRoleId ?? HOME_ROLE_KEY_TO_EMPLOYEE_ROLE_ID[existing.key] ?? `employee_role.${existing.key}`;
    const matchingVal = employeeRoleValues.find(
      (v) =>
        v.id === linkedId ||
        EMPLOYEE_ROLE_TO_HOME_ROLE_KEY[v.id] === existing.key ||
        v.id === `employee_role.${existing.key}`,
    );
    if (matchingVal) {
      matchedKeys.add(existing.key);
      result.push({
        ...existing,
        employeeRoleId: matchingVal.id,
        label: matchingVal.label,
        shortLabel: existing.shortLabel || matchingVal.label,
      });
    } else if (!existing.isBuiltIn) {
      // Preserve custom role if it isn't deactivated in employee_role
      const inactiveMatch = values.find(
        (v) =>
          v.listKey === 'employee_role' &&
          !v.active &&
          (v.id === linkedId || v.id === `employee_role.${existing.key}`),
      );
      if (!inactiveMatch) {
        matchedKeys.add(existing.key);
        result.push({
          ...existing,
          employeeRoleId: linkedId,
        });
      }
    }
  }

  // Ensure any new active `employee_role` taxonomy item has a corresponding RoleHomeConfig
  const fallbackTemplate =
    result.find((r) => r.key === 'fee_earner') ?? defaultRoles[0];

  for (const val of employeeRoleValues) {
    const mappedKey =
      EMPLOYEE_ROLE_TO_HOME_ROLE_KEY[val.id] ?? val.id.replace(/^employee_role\./, '');
    if (matchedKeys.has(mappedKey) || result.some((r) => r.employeeRoleId === val.id)) {
      continue;
    }
    const defaultMatch = defaultRoles.find(
      (d) => d.key === mappedKey || d.employeeRoleId === val.id,
    );
    if (defaultMatch) {
      matchedKeys.add(defaultMatch.key);
      result.push({
        ...defaultMatch,
        employeeRoleId: val.id,
        label: val.label,
      });
    } else {
      matchedKeys.add(mappedKey);
      result.push({
        key: mappedKey,
        employeeRoleId: val.id,
        label: val.label,
        shortLabel: val.label,
        purpose: val.description || `Tailored Home page for ${val.label}.`,
        headlineCardIds: [...fallbackTemplate.headlineCardIds],
        primaryPanels: [...fallbackTemplate.primaryPanels],
        summaryPanels: [...fallbackTemplate.summaryPanels],
        isBuiltIn: false,
      });
    }
  }

  return result;
}

export function createDefaultHomePagesConfig(now = '2026-10-16T09:00:00Z'): HomePagesConfig {
  return {
    roles: createDefaultRoleConfigs(),
    firmSettings: {
      demoMode: false,
      workingDayPaceHours: null,
      wipAgeThresholdDays: 60,
      debtOverdueThresholdDays: 30,
      callbackSlaOverdueMinutes: 0,
    },
    lastViewingRoleByUserId: {},
    updatedAt: now,
    updatedById: 'system',
  };
}

export function getPanelPlacement(roleConfig: RoleHomeConfig, panelId: PanelId): PanelPlacement {
  if (roleConfig.primaryPanels.includes(panelId)) return 'primary';
  if (roleConfig.summaryPanels.includes(panelId)) return 'summary';
  return 'off';
}

export function cyclePanelPlacement(current: PanelPlacement): PanelPlacement {
  if (current === 'primary') return 'summary';
  if (current === 'summary') return 'off';
  return 'primary';
}

export function setRolePanelPlacement(
  roleConfig: RoleHomeConfig,
  panelId: PanelId,
  placement: PanelPlacement
): RoleHomeConfig {
  const primaryPanels = roleConfig.primaryPanels.filter((id) => id !== panelId);
  const summaryPanels = roleConfig.summaryPanels.filter((id) => id !== panelId);
  if (placement === 'primary') {
    primaryPanels.push(panelId);
  } else if (placement === 'summary') {
    summaryPanels.push(panelId);
  }
  return {
    ...roleConfig,
    primaryPanels,
    summaryPanels,
  };
}

/**
 * Derive an employee's multi-role array (`roles`) if not explicitly set, or return their explicit `roles`.
 * The first element (`roles[0]`) is the employee's default Home role.
 */
export function resolveEmployeeRoles(person: Person, teams: Team[] = []): string[] {
  return resolvePersonAuthoritativeRoles(person, teams);
}

/**
 * Resolve which role the user is currently viewing Home as.
 * Checks `lastViewingRoleByUserId[user.id]`, validated against the user's own `roles`.
 * Falls back to `roles[0]`.
 */
export function resolveActiveViewingRole(
  person: Person | null | undefined,
  config: HomePagesConfig,
  teams: Team[] = []
): string {
  if (!person) return 'fee_earner';
  const userRoles = resolveEmployeeRoles(person, teams);
  const remembered = config.lastViewingRoleByUserId?.[person.id];
  if (remembered && userRoles.includes(remembered)) {
    return remembered;
  }
  return userRoles[0] || 'fee_earner';
}

export interface LeftRailVisibility {
  home: boolean;
  enquiries: boolean;
  tasks: boolean;
  keyDates: boolean;
  matters: boolean;
  contacts: boolean;
  finance: boolean;
  risk: boolean;
  admin: boolean;
}

/**
 * Compute left-rail item visibility based on the user's active viewing role and full role list.
 * Matches docs/role-home-pages.md and docs/designs/home/01..07.
 */
export function getLeftRailVisibility(activeRole: string, userRoles: string[] = [activeRole]): LeftRailVisibility {
  const activeTenantId = resolveActiveTenantIdForRbac();
  const config = { rbac: getDefaultTenantRbacConfig(activeTenantId) };
  const authoritativeRoles = userRoles.length > 0 ? userRoles : [activeRole];
  const userPerms = resolvePermissions({
    context: {
      tenantId: activeTenantId,
      correlationId: '',
      actorId: '__rail_user__',
      actorRoles: authoritativeRoles,
      mfaVerified: false,
    },
    actor: { userId: '__rail_user__', roles: authoritativeRoles },
    config,
  });
  const activeRolePerms = resolvePermissions({
    context: {
      tenantId: activeTenantId,
      correlationId: '',
      actorId: '__rail_active_role__',
      actorRoles: [activeRole],
      mfaVerified: false,
    },
    actor: { userId: '__rail_active_role__', roles: [activeRole] },
    config,
  });

  const isFinanceView = activeRole === 'finance';
  const isIntakeView = activeRole === 'enquiries_coordinator';

  const canSeeKeyDates = userPerms.has('keydate:view');
  const canSeeFinance = userPerms.has('finance:view') && activeRolePerms.has('finance:view');
  const canSeeRisk = userPerms.has('risk:view') && activeRolePerms.has('risk:view');
  const canSeeAdmin = userPerms.has('admin:access');

  return {
    home: true,
    enquiries: !isFinanceView,
    tasks: true,
    keyDates: canSeeKeyDates,
    matters: !isIntakeView,
    contacts: true,
    finance: canSeeFinance,
    risk: canSeeRisk,
    admin: canSeeAdmin,
  };
}
