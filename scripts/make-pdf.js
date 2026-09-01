/**
 * Render docs/*.html to PDF.
 *
 *   npm run pdf
 *
 * Chromium's own print engine does the work, so what you get is exactly what
 * Ctrl+P in the browser would produce -- @page rules, page breaks and all.
 * Edit the HTML, re-run this, commit the PDF.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'docs');

// Add an entry here to render another document.
const JOBS = [
  { html: 'architecture.html', pdf: 'ARCHITECTURE.pdf' },
];

const browser = await puppeteer.launch();

try {
  for (const job of JOBS) {
    const src = path.join(DOCS, job.html);
    if (!fs.existsSync(src)) {
      console.error(`  skipped: ${job.html} does not exist`);
      continue;
    }

    const page = await browser.newPage();

    // waitUntil networkidle0 so fonts and any images are settled before print;
    // otherwise the first page can render in a fallback face.
    await page.goto(pathToFileURL(src).href, { waitUntil: 'networkidle0' });

    const out = path.join(DOCS, job.pdf);
    await page.pdf({
      path: out,
      format: 'A4',
      printBackground: true,   // without this every coloured panel prints white
      preferCSSPageSize: true, // honour the @page margins in the stylesheet
    });

    await page.close();

    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log(`  ${job.pdf}  (${kb} KB)`);
  }
} finally {
  await browser.close();
}
