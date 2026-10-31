import React from 'react';
import Link from 'next/link';

/**
 * Minimal Markdown renderer for System documentation (no external dependency).
 * Supports: # / ## / ### headings (with anchor ids), paragraphs, - and 1. lists,
 * > blockquotes, | tables |, **bold**, *italic*, `code` and [links](href).
 */

export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Render inline formatting: links, bold, italic, code. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${i++}`;
    if (match[1]) {
      const label = match[2]!;
      const href = match[3]!;
      const internal = href.startsWith('/') || href.startsWith('#');
      nodes.push(
        internal ? (
          <Link key={key} href={href}>
            {renderInline(label, key)}
          </Link>
        ) : (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {renderInline(label, key)}
          </a>
        ),
      );
    } else if (match[4]) {
      nodes.push(<strong key={key}>{renderInline(match[5]!, key)}</strong>);
    } else if (match[6]) {
      nodes.push(<code key={key}>{match[7]}</code>);
    } else if (match[8]) {
      nodes.push(<em key={key}>{renderInline(match[9]!, key)}</em>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function MarkdownContent({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      const id = headingId(text);
      const children = renderInline(text, id);
      blocks.push(
        level === 1 ? (
          <h1 key={key()} id={id}>{children}</h1>
        ) : level === 2 ? (
          <h2 key={key()} id={id}>{children}</h2>
        ) : (
          <h3 key={key()} id={id}>{children}</h3>
        ),
      );
      i++;
      continue;
    }

    if (trimmed.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(lines[i++]!);
      const header = splitRow(rows[0]!);
      const body = rows.slice(1).filter((r) => !/^\|?\s*:?-{2,}/.test(r.trim()));
      const tk = key();
      blocks.push(
        <table key={tk}>
          <thead>
            <tr>
              {header.map((h, hi) => (
                <th key={hi}>{renderInline(h, `${tk}h${hi}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>
                {splitRow(r).map((c, ci) => (
                  <td key={ci}>{renderInline(c, `${tk}r${ri}c${ci}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quote.push(lines[i++]!.trim().replace(/^>\s?/, ''));
      }
      const qk = key();
      blocks.push(
        <blockquote key={qk}>
          <p>{renderInline(quote.join(' '), qk)}</p>
        </blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const ordered = /^\d+\.\s+/.test(trimmed);
      const items: string[] = [];
      const itemPattern = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      while (i < lines.length && itemPattern.test(lines[i]!.trim())) {
        items.push(lines[i++]!.trim().replace(itemPattern, ''));
      }
      const lk = key();
      const lis = items.map((it, ii) => <li key={ii}>{renderInline(it, `${lk}-${ii}`)}</li>);
      blocks.push(ordered ? <ol key={lk}>{lis}</ol> : <ul key={lk}>{lis}</ul>);
      continue;
    }

    // Paragraph: consecutive non-blank lines that don't start another block
    const para: string[] = [];
    while (i < lines.length) {
      const t = lines[i]!.trim();
      if (!t || /^(#{1,3}\s|\||>|[-*]\s|\d+\.\s)/.test(t)) break;
      para.push(t);
      i++;
    }
    if (para.length === 0) {
      // Unrecognised line that looks like a block start: render it as text and move on
      para.push(trimmed);
      i++;
    }
    const pk = key();
    blocks.push(<p key={pk}>{renderInline(para.join(' '), pk)}</p>);
  }

  return <>{blocks}</>;
}
