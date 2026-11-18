import type { CanvasResourceLink } from './types';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string, maxLength?: number): string {
  const text = decodeHtmlEntities(
    String(html || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();

  return maxLength === undefined ? text : text.slice(0, maxLength);
}

export function extractCanvasFileLinks(html: string, origin: string): string[] {
  return extractResourceLinks(html, origin)
    .filter((link) => !link.external && (/\.pdf(?:$|\?)/i.test(link.url) || /\/files\//i.test(link.url)))
    .map((link) => link.url)
    .slice(0, 10);
}

function attributeValue(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match?.[1] || null;
}

function normalizeLink(value: string, origin: string): URL | null {
  try {
    const url = new URL(decodeHtmlEntities(value), origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

export function extractResourceLinks(
  html: string,
  origin: string,
  maxLinks = 50,
): CanvasResourceLink[] {
  const links = new Map<string, CanvasResourceLink>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of String(html || '').matchAll(anchorPattern)) {
    const attributes = match[1] || '';
    const href = attributeValue(attributes, 'href');
    if (!href) continue;
    const url = normalizeLink(href, origin);
    if (!url) continue;
    const apiValue = attributeValue(attributes, 'data-api-endpoint');
    const apiUrl = apiValue ? normalizeLink(apiValue, origin) : null;
    const kind = attributeValue(attributes, 'data-api-returntype');
    const label = htmlToText(match[2] || '', 300) || url.pathname.split('/').filter(Boolean).pop() || url.hostname;
    const key = `${url.href}|${apiUrl?.href || ''}`;
    if (!links.has(key)) {
      links.set(key, {
        label,
        url: url.href,
        apiUrl: apiUrl?.href || null,
        kind,
        external: url.origin !== origin,
      });
    }
    if (links.size >= maxLinks) break;
  }

  return [...links.values()];
}

export function canvasFileIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.pathname.match(/(?:\/api\/v1)?\/files\/(?:file_id:)?([^/]+)/i)?.[1] ||
      url.pathname.match(/\/courses\/[^/]+\/files\/([^/]+)/i)?.[1] ||
      null;
  } catch {
    return null;
  }
}
