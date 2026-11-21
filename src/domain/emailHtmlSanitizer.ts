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
    .replace(/'/g, '&#39;')
    .replace(
      /[\u202A-\u202E\u2066-\u2069]/g,
      (ch) => `&#x${ch.codePointAt(0)!.toString(16).toUpperCase()};`,
    );
}

function decodeHtmlTextEntities(text: string): string {
  return text.replace(
    /&(nbsp|amp|lt|gt|quot|apos|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/gi,
    (full, entity: string, dec?: string, hex?: string) => {
      if (dec !== undefined) {
        const cp = Number.parseInt(dec, 10);
        if (cp === 160) return ' ';
        return cp >= 32 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
          ? String.fromCodePoint(cp)
          : full;
      }
      if (hex !== undefined) {
        const cp = Number.parseInt(hex, 16);
        if (cp === 0xa0) return ' ';
        return cp >= 32 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
          ? String.fromCodePoint(cp)
          : full;
      }
      switch (entity.toLowerCase()) {
        case 'nbsp':
          return ' ';
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return full;
      }
    },
  );
}

function stripDangerousContainers(rawHtml: string): string {
  let current = rawHtml;
  for (let pass = 0; pass < 16; pass += 1) {
    const next = current
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
      .replace(/<embed\b[^>]*>/gi, '')
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '');
    if (next === current) {
      break;
    }
    current = next;
  }
  return current
    .replace(/<script\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*$/gi, '');
}

/**
 * Sanitises composer HTML against an attribute-free allow-list and balances
 * opened tags so arbitrary HTML/XSS payloads cannot reach outbound emails or UI
 * `dangerouslySetInnerHTML`. Decodes basic HTML entities in text segments in
 * a single pass before escaping so entities such as `&amp;` and `&nbsp;` do
 * not double-escape (`R623`).
 */
export function sanitizeEnquiryEmailHtml(rawHtml: string): string {
  if (!rawHtml || !rawHtml.trim()) {
    return '';
  }

  const preStripped = stripDangerousContainers(rawHtml);
  const tagRegex = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)(?:\s[^<>]*?)?\s*(\/?)\s*>/g;

  const openStack: string[] = [];
  const parts: string[] = [];
  let cursor = 0;

  for (const match of preStripped.matchAll(tagRegex)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) {
      parts.push(
        escapeHtmlText(decodeHtmlTextEntities(preStripped.slice(cursor, matchIndex))),
      );
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
    parts.push(escapeHtmlText(decodeHtmlTextEntities(preStripped.slice(cursor))));
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
 * Converts plain-text email content into single-escaped, allow-listed paragraph
 * HTML for fallback viewing without double-escaping existing characters (`R623`).
 */
export function plainTextToSanitizedEmailHtml(bodyText: string): string {
  if (!bodyText || !bodyText.trim()) {
    return '';
  }
  return `<p>${escapeHtmlText(bodyText.trim()).replace(/\r?\n/g, '<br />')}</p>`;
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
  return decodeHtmlTextEntities(stripped)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
