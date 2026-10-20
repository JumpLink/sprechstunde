import * as cheerio from 'cheerio';

export interface Sitemap {
  /** Page addresses (`<url><loc>`). */
  pages: string[];
  /** Nested sitemaps of a sitemap index (`<sitemap><loc>`). */
  sitemaps: string[];
}

export function parseSitemap(xml: string): Sitemap {
  const $ = cheerio.load(xml, { xml: true });
  const locs = (selector: string): string[] =>
    $(selector)
      .map((_index, element) => $(element).text().trim())
      .get()
      .filter((loc) => loc !== '');
  return { pages: locs('urlset > url > loc'), sitemaps: locs('sitemapindex > sitemap > loc') };
}

function patternOf(glob: string): RegExp {
  const body = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * Include globs for a sitemap source. `*` stays inside one path segment, `**` crosses them. A glob
 * starting with `/` is matched against the path, any other against the whole address. An empty list
 * includes everything.
 */
export function matchesGlobs(address: string, globs: string[]): boolean {
  if (globs.length === 0) return true;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  return globs.some((glob) => patternOf(glob).test(glob.startsWith('/') ? url.pathname : url.href));
}

/** Only pages of the sitemap's own host: a sitemap cannot send the fetcher elsewhere. */
export function sameHost(address: string, sitemapAddress: string): boolean {
  try {
    return new URL(address).host === new URL(sitemapAddress).host;
  } catch {
    return false;
  }
}
