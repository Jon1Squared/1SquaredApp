import { describe, expect, it } from 'vitest';
import * as sanitizer from '../emailHtmlSanitizer';

const { sanitizeEnquiryEmailHtml, extractPlainTextFromEmailHtml } = sanitizer;

describe('emailHtmlSanitizer (R602, R623)', () => {
  it.each([
    {
      name: 'decodes &amp; in composer HTML instead of double-escaping',
      input: '<p>Smith &amp; Co</p>',
      expected: '<p>Smith &amp; Co</p>',
    },
    {
      name: 'escapes bare ampersands in raw text',
      input: '<p>Smith & Co</p>',
      expected: '<p>Smith &amp; Co</p>',
    },
    {
      name: 'normalises &nbsp; to a regular space without double-escaping',
      input: '<p>Hello&nbsp;World</p>',
      expected: '<p>Hello World</p>',
    },
    {
      name: 'decodes numeric entities safely in text without re-parsing as tags',
      input: '<p>AT&#38;T &lt;1 &amp; 2&#62; &quot;quoted&quot;</p>',
      expected: '<p>AT&amp;T &lt;1 &amp; 2&gt; &quot;quoted&quot;</p>',
    },
    {
      name: 'strips nested <scr<script>ipt> containers to fixed point with zero script payload',
      input: '<scr<script></script>ipt>alert(1)</script><p>Safe body</p>',
      expected: '<p>Safe body</p>',
    },
    {
      name: 'strips nested <scr<script>ipt> returning empty string when no safe body remains',
      input: '<scr<script></script>ipt>alert(1)</script>',
      expected: '',
    },
    {
      name: 'strips <svg onload> containers',
      input: '<svg onload="alert(1)"><circle r="10"/></svg><p>Follow up</p>',
      expected: '<p>Follow up</p>',
    },
    {
      name: 'strips <a href="javascript:..."> attributes while keeping anchor text',
      input: '<p><a href="javascript:alert(1)">Click</a></p>',
      expected: '<p>Click</p>',
    },
    {
      name: 'strips unquoted and entity-encoded attributes on <a> tags',
      input:
        '<p><a href=&#106;avascript:alert(1) onclick=alert(2)>Read &amp; confirm</a></p>',
      expected: '<p>Read &amp; confirm</p>',
    },
    {
      name: 'keeps numeric comparison text "< 10" instead of treating it as a tag',
      input: '<p>5 < 10 and 20 > 10</p>',
      expected: '<p>5 &lt; 10 and 20 &gt; 10</p>',
    },
  ])('R623 sanitiser table: $name', ({ input, expected }) => {
    expect(sanitizeEnquiryEmailHtml(input)).toBe(expected);
  });

  it('R623: plainTextToSanitizedEmailHtml escapes plain text without double-escaping entities for viewer fallback', () => {
    const fn = (
      sanitizer as unknown as {
        plainTextToSanitizedEmailHtml?: (text: string) => string;
      }
    ).plainTextToSanitizedEmailHtml;
    expect(typeof fn).toBe('function');
    expect(fn!('Smith & Co\nLine <2>')).toBe(
      '<p>Smith &amp; Co<br />Line &lt;2&gt;</p>',
    );
    expect(extractPlainTextFromEmailHtml('<p>Smith &amp; Co</p>')).toBe(
      'Smith & Co',
    );
  });
});
