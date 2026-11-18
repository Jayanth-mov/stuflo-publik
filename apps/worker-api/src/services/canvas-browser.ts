import puppeteer from '@cloudflare/puppeteer';
import {
  cookieMatchesHost,
  normalizeCanvasHost,
  type CanvasBrowserPage,
  type CanvasConnection,
} from '@stuflo/lms';
import type { StufloEnv } from '../env';

export async function readCanvasPageInBrowser(
  env: StufloEnv,
  connection: CanvasConnection,
  rawUrl: string,
  options: { allowExternalNavigation?: boolean } = {},
): Promise<CanvasBrowserPage> {
  if (!env.BROWSER) throw new Error('Cloudflare Browser Run is not configured.');
  const host = normalizeCanvasHost(connection.canvasHost);
  const origin = `https://${host}`;
  const requested = new URL(rawUrl, origin);
  if (requested.protocol !== 'https:' || (!options.allowExternalNavigation && requested.origin !== origin)) {
    throw new Error('Browser navigation must start on the connected Canvas host.');
  }

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setCookie(
      ...connection.cookies
        .filter((cookie) => cookieMatchesHost(cookie, host))
        .slice(0, 100)
        .map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly === true,
        })),
    );
    await page.goto(requested.href, { waitUntil: 'networkidle2', timeout: 25_000 });
    const finalUrl = page.url();
    if (!options.allowExternalNavigation && new URL(finalUrl).origin !== origin) {
      throw new Error('The Canvas page redirected outside the connected Canvas host.');
    }
    if (options.allowExternalNavigation) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      let externalToolButton = null;
      const submitButtons = await page.$$('form button[type="submit"]');
      for (const button of submitButtons.slice(0, 30)) {
        const label = await button.evaluate((element) => element.textContent || '').catch(() => '');
        if (/load .+ in a new window/i.test(label)) {
          externalToolButton = button;
          break;
        }
      }
      if (externalToolButton) {
        const navigation = page
          .waitForNavigation({ waitUntil: 'networkidle2', timeout: 20_000 })
          .catch(() => null);
        await externalToolButton.evaluate((button) => {
          type BrowserForm = { target: string; submit(): void };
          type BrowserButton = { closest(selector: string): BrowserForm | null };
          const form = (button as unknown as BrowserButton).closest('form');
          if (!form) throw new Error('External tool launch form was not found.');
          form.target = '_self';
          form.submit();
        });
        await navigation;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    const frameResults: Array<{
      pageUrl: string;
      url: string;
      title: string;
      text: string;
      links: Array<{ label: string; url: string; apiUrl: string | null; kind: string | null }>;
    }> = [];
    const browserPages = options.allowExternalNavigation ? await browser.pages() : [page];
    for (const browserPage of browserPages.slice(0, 6)) {
      const pageUrl = browserPage.url();
      if (!/^https?:\/\//i.test(pageUrl)) continue;
      for (const frame of browserPage.frames().slice(0, 8)) {
        const frameUrl = frame.url();
        if (!/^https?:\/\//i.test(frameUrl)) continue;
        try {
          const result = await frame.evaluate(() => {
            type BrowserAnchor = {
              href: string;
              innerText?: string;
              textContent?: string | null;
              getAttribute(name: string): string | null;
            };
            type BrowserRoot = {
              textContent?: string | null;
              querySelectorAll(selector: string): ArrayLike<BrowserAnchor>;
            };
            type BrowserDocument = {
              title?: string;
              body: BrowserRoot;
              querySelector(selector: string): BrowserRoot | null;
            };
            const browserDocument = (globalThis as unknown as { document: BrowserDocument }).document;
            const root = browserDocument.querySelector('main, #content, [role="main"]') || browserDocument.body;
            const links = Array.from(root.querySelectorAll('a[href]'))
              .slice(0, 100)
              .map((anchor) => ({
                label: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
                url: anchor.href,
                apiUrl: anchor.getAttribute('data-api-endpoint'),
                kind: anchor.getAttribute('data-api-returntype'),
              }));
            return {
              title: browserDocument.title || '',
              text: (root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40_000),
              links,
            };
          });
          frameResults.push({ pageUrl, url: frameUrl, ...result });
        } catch {
          // Detached or sandboxed frames are skipped; other pages and frames remain available.
        }
      }
    }
    const primary = [...frameResults]
      .reverse()
      .find((frame) => frame.text && !frame.url.startsWith('https://sso.canvaslms.com/')) ||
      frameResults.find((frame) => frame.url === finalUrl) ||
      frameResults[0];
    const combinedText = frameResults
      .filter((frame) => frame.text)
      .map((frame) => frame.url === finalUrl
        ? frame.text
        : `[Embedded resource: ${frame.title || new URL(frame.url).hostname}] ${frame.text}`)
      .join('\n\n')
      .slice(0, 40_000);
    const seenLinks = new Set<string>();
    return {
      requestedUrl: requested.href,
      finalUrl: primary?.pageUrl || finalUrl,
      title: primary?.title || '',
      text: combinedText,
      links: frameResults.flatMap((frame) => frame.links.flatMap((link) => {
        try {
          const url = new URL(link.url, frame.url);
          if (url.protocol !== 'https:' && url.protocol !== 'http:') return [];
          if (seenLinks.has(url.href)) return [];
          seenLinks.add(url.href);
          const apiCandidate = link.apiUrl ? new URL(link.apiUrl, frame.url) : null;
          const apiUrl = apiCandidate && (apiCandidate.protocol === 'https:' || apiCandidate.protocol === 'http:')
            ? apiCandidate.href
            : null;
          return [{
            label: link.label || url.pathname.split('/').filter(Boolean).pop() || url.hostname,
            url: url.href,
            apiUrl,
            kind: link.kind,
            external: url.origin !== origin,
          }];
        } catch {
          return [];
        }
      })),
    };
  } finally {
    await browser.close();
  }
}
