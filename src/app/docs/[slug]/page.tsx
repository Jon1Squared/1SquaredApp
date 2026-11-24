import { notFound } from 'next/navigation';
import { DocsNav } from '@/components/DocsNav';
import { LoginScreen } from '@/components/LoginScreen';
import { MarkdownContent } from '@/components/MarkdownContent';
import { formatDate } from '@/domain/dates';
import { DOC_SECTIONS, getDocArticle } from '@/docs/registry';
import { getEntraEnvStatus, getEntraSession } from '@/server/entraAuth';
import { AuthorisationError } from '@/server/rbacRuntime';
import { requireAuthenticatedActor } from '@/server/services';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getDocArticle(slug);
  return { title: article ? `${article.title} · 1Squared` : 'System documentation · 1Squared' };
}

export default async function DocArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entraSession = await getEntraSession();
  if (!entraSession) {
    return (
      <LoginScreen
        entraEnvStatus={getEntraEnvStatus()}
        initialReturnTo={`/docs/${encodeURIComponent(slug)}`}
      />
    );
  }

  try {
    await requireAuthenticatedActor();
  } catch (err) {
    if (
      err instanceof AuthorisationError ||
      (err instanceof Error && err.name === 'TenancyError')
    ) {
      return (
        <div
          style={{
            minHeight: '60vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div className="card" style={{ maxWidth: 440, width: '100%', padding: 28 }}>
            <h1 style={{ fontSize: 20, marginBottom: 8 }}>Access unavailable</h1>
            <p className="muted" style={{ marginBottom: 16 }}>
              Your account does not currently have an active employee profile in this
              workspace, so Help &amp; documentation cannot be opened.
            </p>
            <form action="/api/auth/logout" method="POST" style={{ margin: 0 }}>
              <button type="submit" className="btn btn--primary">
                Sign out
              </button>
            </form>
          </div>
        </div>
      );
    }
    throw err;
  }

  const article = getDocArticle(slug);
  if (!article) notFound();
  const sectionTitle = DOC_SECTIONS.find((s) => s.key === article.section)?.title ?? '';

  return (
    <div className="docs-page">
      <DocsNav activeSlug={article.slug} />
      <article className="docs-article">
        <h1>{article.title}</h1>
        <p className="docs-meta">
          {sectionTitle} · Last reviewed {formatDate(article.updated)}
        </p>
        <MarkdownContent source={article.body} />
      </article>
    </div>
  );
}
