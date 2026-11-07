/**
 * System documentation registry.
 *
 * To add an article:
 *   1. Create a file in src/docs/articles/ exporting a DocArticle (copy an existing one).
 *   2. Import it below and add it to ARTICLES.
 *   3. If it needs a new section, add the section to DOC_SECTIONS (order = sidebar order).
 *
 * Article bodies are Markdown. Supported: # / ## / ### headings, paragraphs, - and 1. lists,
 * > notes, | tables |, **bold**, *italic*, `code` and [links](/docs/other-article).
 */
import { aboutDocs } from './articles/about-documentation';
import { authenticationRbacAndMfaArticle } from './articles/authentication-rbac-and-mfa';
import { deploymentAndSecurityArticle } from './articles/deployment-and-security';
import { developmentProcessArticle } from './articles/development-process';
import { documentGenerationArticle } from './articles/document-generation';
import { duplicateChecks } from './articles/duplicate-checks';
import { keyDatesAdministrationArticle } from './articles/key-dates-administration';
import { keyDatesCalendarSyncArticle } from './articles/key-dates-calendar-sync';
import { keyDatesExceptionsArticle } from './articles/key-dates-exceptions';
import { keyDatesLimitationCalculatorArticle } from './articles/key-dates-limitation-calculator';
import { keyDatesManagingArticle } from './articles/key-dates-managing';
import { keyDatesOverviewArticle } from './articles/key-dates-overview';
import { keyDatesRemindersArticle } from './articles/key-dates-reminders';
import { keyDatesTeamDiaryArticle } from './articles/key-dates-team-diary';
import { keyDatesVerificationArticle } from './articles/key-dates-verification';
import { matterOpeningAndRiskArticle } from './articles/matter-opening-and-risk';
import { mattersEnquiriesTasksNavigationArticle } from './articles/matters-enquiries-tasks-and-navigation';
import { quickConflictCheck } from './articles/quick-conflict-check';
import { sharepointDocumentStoreArticle } from './articles/sharepoint-document-store';
import { sharepointSitesSelectedSetupArticle } from './articles/sharepoint-sites-selected-setup';

export interface DocArticle {
  /** URL slug: /docs/<slug>. Keep stable once published, because screens link to it. */
  slug: string;
  title: string;
  /** Must match a DOC_SECTIONS key. */
  section: DocSectionKey;
  /** One or two sentences, shown on the documentation home page. */
  summary: string;
  /** Last reviewed date, YYYY-MM-DD. */
  updated: string;
  /** Markdown body (without the title, which is rendered from `title`). */
  body: string;
}

export const DOC_SECTIONS = [
  { key: 'getting-started', title: 'Getting started' },
  { key: 'architecture-security', title: 'Architecture, Deployment & Security' },
  { key: 'key-dates-limitation', title: 'Key dates and limitation' },
  { key: 'documents-dms', title: 'Documents & SharePoint DMS' },
  { key: 'enquiries', title: 'Enquiries' },
  { key: 'people-organisations', title: 'People & Organisations' },
] as const;

export type DocSectionKey = (typeof DOC_SECTIONS)[number]['key'];

export const ARTICLES: DocArticle[] = [
  aboutDocs,
  matterOpeningAndRiskArticle,
  mattersEnquiriesTasksNavigationArticle,
  deploymentAndSecurityArticle,
  authenticationRbacAndMfaArticle,
  developmentProcessArticle,
  keyDatesOverviewArticle,
  keyDatesManagingArticle,
  keyDatesLimitationCalculatorArticle,
  keyDatesVerificationArticle,
  keyDatesTeamDiaryArticle,
  keyDatesRemindersArticle,
  keyDatesCalendarSyncArticle,
  keyDatesExceptionsArticle,
  keyDatesAdministrationArticle,
  documentGenerationArticle,
  sharepointDocumentStoreArticle,
  sharepointSitesSelectedSetupArticle,
  quickConflictCheck,
  duplicateChecks,
];

export function getDocArticle(slug: string): DocArticle | undefined {
  return ARTICLES.find((a) => a.slug === slug);
}

export function docsBySection(): { key: DocSectionKey; title: string; articles: DocArticle[] }[] {
  return DOC_SECTIONS.map((s) => ({
    key: s.key,
    title: s.title,
    articles: ARTICLES.filter((a) => a.section === s.key),
  })).filter((s) => s.articles.length > 0);
}
