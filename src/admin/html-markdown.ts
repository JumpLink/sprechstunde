import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { _ } from '../i18n.js';

/** What never carries the page's own text: scripts, chrome, forms and embedded frames. */
const ALWAYS_REMOVED = 'script, style, noscript, template, svg, nav, footer, header, iframe, form, aside, img, picture';
export const MAX_EXCLUDES = 20;
const MAX_EXCLUDE_CHARS = 200;

export interface ConvertOptions {
  /** CSS selectors of parts to drop on top of the usual chrome, e.g. a cookie banner. */
  exclude?: string[];
  /** Relative links are made absolute against this address. */
  baseUrl?: string;
}

export interface Converted {
  title: string;
  markdown: string;
}

/** A selector the user typed must not be able to crash the fetch with a parser error. */
export function checkSelectors(selectors: string[]): string[] {
  if (selectors.length > MAX_EXCLUDES) throw new Error(_('too many selectors to exclude'));
  const $ = cheerio.load('<div></div>');
  const clean: string[] = [];
  for (const selector of selectors) {
    const trimmed = selector.trim();
    if (trimmed === '') continue;
    if (trimmed.length > MAX_EXCLUDE_CHARS) throw new Error(_('a selector is too long'));
    try {
      $(trimmed);
    } catch {
      throw new Error(_('"%s" is not a valid CSS selector').replace('%s', trimmed));
    }
    clean.push(trimmed);
  }
  return clean;
}

function absolute(value: string | undefined, base: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function service(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
  });
  turndown.use(gfm);
  return turndown;
}

/**
 * The readable part of a page as Markdown: chrome and scripts out, then `article`, else `main`,
 * else the body. Tables survive (GFM). Links are kept as absolute http(s) links; any other link
 * (`javascript:`, `mailto:`) keeps its text only.
 */
export function htmlToMarkdown(html: string, options: ConvertOptions = {}): Converted {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || $('h1').first().text().trim();
  $(ALWAYS_REMOVED).remove();
  for (const selector of checkSelectors(options.exclude ?? [])) $(selector).remove();
  $('a').each((_index, element) => {
    const link = $(element);
    const href = absolute(link.attr('href'), options.baseUrl);
    if (href) link.attr('href', href);
    else link.removeAttr('href');
  });
  const root = [$('article').first(), $('main').first(), $('body').first()].find((candidate) => candidate.length > 0);
  const markdown = service()
    .turndown(root?.html() ?? '')
    .replace(new RegExp('[ \\t]+\\n', 'g'), '\n')
    .replace(new RegExp('^(\\s*)([-*]|\\d+\\.) {2,}', 'gm'), '$1$2 ')
    .replace(new RegExp('\\n{3,}', 'g'), '\n\n')
    .trim();
  return { title, markdown };
}
