/**
 * SharePoint Library & Folder URL Parser (`core/src/integrations/document-stores/sharepointUrlParser.ts`).
 *
 * Implements Section 9 (Location resolution):
 * - Parses pasted SharePoint Online URLs into `{ hostname, siteRelativePath, libraryUrlSegment, folderRelativePath }`.
 * - Handles URL-encoded spaces (`%20`), `/Forms/AllItems.aspx` and custom view `.aspx` segments,
 *   `?id=/sites/...` query parameters from modern SharePoint folder deep links, `/sites/<name>` and `/teams/<name>`,
 *   and nested subfolder paths.
 * - Zero client-specific names or URLs.
 */

export interface ParsedSharePointUrl {
  valid: boolean;
  hostname?: string;
  siteRelativePath?: string;
  libraryUrlSegment?: string;
  folderRelativePath?: string;
  normalizedWebUrl?: string;
  errorReason?: string;
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).trim();
  } catch {
    return segment.trim();
  }
}

/**
 * Parses a pasted SharePoint site, document library, or folder URL into structured components
 * suitable for Microsoft Graph site and drive resolution.
 */
export function parseSharePointLocationUrl(
  rawInput: string,
  expectedHostname?: string,
  expectedSiteRelativePath?: string,
): ParsedSharePointUrl {
  const trimmed = (rawInput ?? '').trim();
  if (!trimmed) {
    return {
      valid: false,
      errorReason: 'SharePoint location URL or path cannot be empty.',
    };
  }

  // Allow relative path when expectedHostname and expectedSiteRelativePath are provided
  let urlObj: URL;
  try {
    if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
      urlObj = new URL(trimmed);
    } else if (expectedHostname && expectedSiteRelativePath) {
      const normalizedRel = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      const sitePrefix = expectedSiteRelativePath.startsWith('/')
        ? expectedSiteRelativePath
        : `/${expectedSiteRelativePath}`;
      const fullPath = normalizedRel
        .toLowerCase()
        .startsWith(sitePrefix.toLowerCase())
        ? normalizedRel
        : `${sitePrefix.replace(/\/$/, '')}${normalizedRel}`;
      urlObj = new URL(`https://${expectedHostname}${fullPath}`);
    } else {
      return {
        valid: false,
        errorReason:
          'Invalid SharePoint URL: must be a full https:// URL or specify a configured site.',
      };
    }
  } catch {
    return {
      valid: false,
      errorReason: 'Invalid URL syntax.',
    };
  }

  if (urlObj.protocol !== 'https:') {
    return {
      valid: false,
      errorReason: 'SharePoint URLs must use HTTPS.',
    };
  }

  const hostname = urlObj.hostname.toLowerCase();
  if (
    expectedHostname &&
    hostname !== expectedHostname.toLowerCase()
  ) {
    return {
      valid: false,
      errorReason: `URL hostname "${hostname}" does not match configured store hostname "${expectedHostname}".`,
    };
  }

  // Modern SharePoint often encodes the actual folder path in the `?id=` or `?RootFolder=` query parameter
  // when viewing `/Forms/AllItems.aspx`.
  const queryFolderParam =
    urlObj.searchParams.get('id') ?? urlObj.searchParams.get('RootFolder');

  const effectivePathname = queryFolderParam
    ? safeDecodeSegment(queryFolderParam)
    : urlObj.pathname;

  const rawSegments = effectivePathname
    .split('/')
    .map((s) => safeDecodeSegment(s))
    .filter(Boolean);

  if (rawSegments.length < 2) {
    return {
      valid: false,
      errorReason:
        'SharePoint URL must include a site path (for example "/sites/SiteName") and document library segment.',
    };
  }

  const rootCollection = rawSegments[0]!.toLowerCase();
  if (rootCollection !== 'sites' && rootCollection !== 'teams') {
    return {
      valid: false,
      errorReason:
        'SharePoint URL path must start with "/sites/<SiteName>" or "/teams/<TeamName>".',
    };
  }

  const siteName = rawSegments[1]!;
  const siteRelativePath = `/${rawSegments[0]}/${siteName}`;

  if (
    expectedSiteRelativePath &&
    siteRelativePath.toLowerCase() !== expectedSiteRelativePath.toLowerCase()
  ) {
    return {
      valid: false,
      errorReason: `URL site path "${siteRelativePath}" does not match configured site "${expectedSiteRelativePath}".`,
    };
  }

  const afterSiteSegments = rawSegments.slice(2);
  if (afterSiteSegments.length === 0) {
    return {
      valid: false,
      hostname,
      siteRelativePath,
      errorReason:
        'SharePoint URL points to the site root rather than a document library or folder.',
    };
  }

  const libraryUrlSegment = afterSiteSegments[0]!;
  const remaining = afterSiteSegments.slice(1);

  // Strip `/Forms/<ViewName>.aspx` view segments if present
  let folderSegments = remaining;
  if (
    folderSegments.length >= 1 &&
    folderSegments[0]!.toLowerCase() === 'forms'
  ) {
    const afterForms = folderSegments.slice(1);
    if (
      afterForms.length === 0 ||
      afterForms[0]!.toLowerCase().endsWith('.aspx')
    ) {
      folderSegments = afterForms.slice(1);
    }
  } else if (
    folderSegments.length > 0 &&
    folderSegments[folderSegments.length - 1]!.toLowerCase().endsWith('.aspx')
  ) {
    folderSegments = folderSegments.slice(0, -1);
  }

  const folderRelativePath = folderSegments.join('/');
  const encodedPathSegments = [
    rawSegments[0]!,
    siteName,
    libraryUrlSegment,
    ...folderSegments,
  ].map((s) => encodeURIComponent(s));

  const normalizedWebUrl = `https://${hostname}/${encodedPathSegments.join('/')}`;

  return {
    valid: true,
    hostname,
    siteRelativePath,
    libraryUrlSegment,
    folderRelativePath,
    normalizedWebUrl,
  };
}
