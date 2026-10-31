import { notFound } from 'next/navigation';
import { DocsNav } from '@/components/DocsNav';
import { MarkdownContent } from '@/components/MarkdownContent';
import { formatDate } from '@/domain/dates';
import { ARTICLES, DOC_SECTIONS, getDocArticle } from '@/docs/registry';

export function generateStaticParams() {
  return ARTICLES.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = getDocArticle(slug);
  return { title: article ? `${article.title} · 1Squared` : 'System documentation · 1Squared' };
}

export default async function DocArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
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
