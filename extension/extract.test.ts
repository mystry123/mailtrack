// @vitest-environment node
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const code = readFileSync(new URL('./extract.js', import.meta.url), 'utf8');

type Extract = (doc: Document, url: string, now?: number) => Record<string, unknown> | null;
function load(html: string): { extract: Extract; doc: Document } {
  const dom = new JSDOM(html);
  new Function('window', code)(dom.window);
  return { extract: (dom.window as unknown as { mailtrackExtract: Extract }).mailtrackExtract, doc: dom.window.document };
}

const NOW = Date.parse('2026-10-22T12:00:00Z');

describe('extract (job pages)', () => {
  it('reads schema.org JobPosting data', () => {
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Founding Fullstack Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Cardboard' },
      jobLocation: { address: { addressLocality: 'San Francisco', addressRegion: 'CA', addressCountry: 'US' } },
      datePosted: '2026-09-01',
      description: '<p>Build the editor.</p><ul><li>React</li><li>Node</li></ul>',
      baseSalary: { currency: 'USD', value: { minValue: 150000, maxValue: 200000, unitText: 'YEAR' } },
    };
    const { extract, doc } = load(`<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><h1>x</h1></body></html>`);
    const r = extract(doc, 'https://jobs.ashbyhq.com/cardboard/123#apply', NOW)!;
    expect(r).toMatchObject({
      url: 'https://jobs.ashbyhq.com/cardboard/123',
      company: 'Cardboard',
      role: 'Founding Fullstack Engineer',
      location: 'San Francisco, CA, US',
      salary: 'USD 150,000–200,000 / year',
      site: 'ashby',
      reposted: false,
    });
    expect(r.description).toContain('Build the editor.');
    expect(r.description).toContain('React');
    expect(r.postedAt).toBe(new Date('2026-09-01').toISOString());
  });

  it('handles @graph and remote jobs', () => {
    const ld = { '@graph': [{ '@type': 'WebPage' }, { '@type': 'JobPosting', title: 'SWE', hiringOrganization: 'Acme', jobLocationType: 'TELECOMMUTE' }] };
    const { extract, doc } = load(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
    expect(extract(doc, 'https://acme.com/careers/swe', NOW)).toMatchObject({ company: 'Acme', role: 'SWE', location: 'Remote', site: 'web' });
  });

  it('reads LinkedIn job pages, including reposts and age', () => {
    const { extract, doc } = load(`
      <div class="job-details-jobs-unified-top-card__container--two-pane">
        <div class="job-details-jobs-unified-top-card__company-name"><a>Pixory</a></div>
        <div class="job-details-jobs-unified-top-card__job-title"><h1>Backend Engineer</h1></div>
        <div>Bengaluru, Karnataka, India · Reposted 3 weeks ago · Over 100 applicants</div>
      </div>
      <div id="job-details">We build photo books.</div>`);
    const r = extract(doc, 'https://www.linkedin.com/jobs/view/4012345/', NOW)!;
    expect(r).toMatchObject({ company: 'Pixory', role: 'Backend Engineer', reposted: true, site: 'linkedin', description: 'We build photo books.' });
    expect(r.location).toContain('Bengaluru');
    expect(Math.round((NOW - Date.parse(r.postedAt as string)) / 864e5)).toBe(21);
  });

  it('falls back to Lever and Greenhouse layouts and the URL', () => {
    const lever = load('<div class="posting-headline"><h2>Platform Engineer</h2></div><div class="posting-categories"><div class="location">Remote</div></div>');
    expect(lever.extract(lever.doc, 'https://jobs.lever.co/delta-labs/abc', NOW)).toMatchObject({ company: 'Delta Labs', role: 'Platform Engineer', location: 'Remote', site: 'lever' });
    const gh = load('<h1 class="app-title">Data Engineer</h1><span class="company-name">at Epsilon</span><div class="location">NYC</div><div id="content">Hi</div>');
    expect(gh.extract(gh.doc, 'https://boards.greenhouse.io/epsilon/jobs/1', NOW)).toMatchObject({ company: 'Epsilon', role: 'Data Engineer', location: 'NYC' });
  });

  it('uses "Role at Company" page titles as a last resort', () => {
    const { extract, doc } = load('<title>Senior Engineer at Zeta | Zeta Careers</title><h1>Senior Engineer</h1>');
    expect(extract(doc, 'https://zeta.io/jobs/1', NOW)).toMatchObject({ company: 'Zeta', role: 'Senior Engineer' });
  });

  it('survives junk JSON-LD and bad URLs', () => {
    const { extract, doc } = load('<script type="application/ld+json">{not json</script><h1>Role</h1>');
    expect(extract(doc, 'not a url')).toBeNull();
    expect(extract(doc, 'https://x.co/j', NOW)).toMatchObject({ role: 'Role' });
  });
});
