import Link from 'next/link';
import { DocsNav } from '@/components/DocsNav';
import { docsBySection } from '@/docs/registry';

export const metadata = { title: 'System documentation · 1Squared' };

export default function DocsHomePage() {
  return (
    <div className="docs-page">
      <DocsNav />
      <article className="docs-article">
        <h1>System documentation</h1>
        <p className="docs-meta">How 1Squared works, and the rules behind its automatic checks.</p>
        {docsBySection().map((section) => (
          <section key={section.key}>
            <h2>{section.title}</h2>
            <div className="docs-index-grid">
              {section.articles.map((a) => (
                <Link key={a.slug} href={`/docs/${a.slug}`} className="docs-card">
                  <div className="docs-card__title">{a.title}</div>
                  <div className="docs-card__summary">{a.summary}</div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </article>
    </div>
  );
}
