import Link from 'next/link';
import { docsBySection } from '@/docs/registry';

/** Sidebar listing every documentation section and article. */
export function DocsNav({ activeSlug }: { activeSlug?: string }) {
  return (
    <nav className="docs-nav" aria-label="System documentation">
      <Link href="/docs" className="docs-nav__home" aria-current={activeSlug ? undefined : 'page'}>
        System documentation
      </Link>
      {docsBySection().map((section) => (
        <div key={section.key} className="docs-nav__section">
          <div className="docs-nav__section-title">{section.title}</div>
          {section.articles.map((a) => (
            <Link
              key={a.slug}
              href={`/docs/${a.slug}`}
              className="docs-nav__link"
              aria-current={a.slug === activeSlug ? 'page' : undefined}
            >
              {a.title}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
