/**
 * Minimal allow-list HTML sanitiser and plain-text extractor for enquiry emails
 * (`R602`). Strips active content (`<script>`, `<style>`, `<iframe>`, `<object>`,
 * `<embed>`, comments), strips `<img>` and all attributes (including `on*`,
 * `style`, `href`, `src`), escapes text nodes, and keeps only attribute-free
 * balanced formatting tags produced by the enquiry composer.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  'h3',
  'ul',
  'ol',
  'li',
  'div',
]);

const SELF_CLOSING_TAGS = new Set(['br']);

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripDangerousContainers(rawHtml: string): string {
  return rawHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '');
}

/**
 * Sanitises composer HTML against an attribute-free allow-list and balances
 * opened tags so arbitrary HTML/XSS payloads cannot reach outbound emails or UI
 * `dangerouslySetInnerHTML`.
 */
export function sanitizeEnquiryEmailHtml(rawHtml: string): string {
  if (!rawHtml || !rawHtml.trim()) {
    return '';
  }

  const preStripped = stripDangerousContainers(rawHtml);
  const tagRegex = /<\s*(\/?)\s*([a-zA-Z0-9:-]+)(?:\s[^<>]*?)?\s*(\/?)\s*>/g;

  const openStack: string[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const match of preStripped.matchAll(tagRegex)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) {
      parts.push(escapeHtmlText(preStripped.slice(cursor, matchIndex)));
    }
    cursor = matchIndex + match[0].length;

    const isClosing = match[1] === '/';
    const tagName = (match[2] ?? '').toLowerCase();
    const isSelfClosing = match[3] === '/' || SELF_CLOSING_TAGS.has(tagName);

    if (!ALLOWED_TAGS.has(tagName)) {
      continue;
    }

    if (SELF_CLOSING_TAGS.has(tagName)) {
      if (!isClosing) {
        parts.push('<br />');
      }
      continue;
    }

    if (isSelfClosing && !isClosing) {
      parts.push(`<${tagName}></${tagName}>`);
      continue;
    }

    if (!isClosing) {
      openStack.push(tagName);
      parts.push(`<${tagName}>`);
    } else {
      const stackIdx = openStack.lastIndexOf(tagName);
      if (stackIdx !== -1) {
        while (openStack.length > stackIdx) {
          const popped = openStack.pop()!;
          parts.push(`</${popped}>`);
        }
      }
    }
  }

  if (cursor < preStripped.length) {
    parts.push(escapeHtmlText(preStripped.slice(cursor)));
  }

  while (openStack.length > 0) {
    parts.push(`</${openStack.pop()!}>`);
  }

  const joined = parts.join('').trim();
  const visibleText = extractPlainTextFromEmailHtml(joined);
  if (!visibleText) {
    return '';
  }
  return joined;
}

/**
 * Extracts plain text from enquiry email HTML after stripping active containers
 * so `<script>…</script>` payloads never turn into plain-text body fallback.
 */
export function extractPlainTextFromEmailHtml(rawOrSanitizedHtml: string): string {
  if (!rawOrSanitizedHtml) return '';
  const stripped = stripDangerousContainers(rawOrSanitizedHtml)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h3|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeBasicEntities(stripped)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
