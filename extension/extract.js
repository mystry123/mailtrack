// Reads a job posting off the current page: company, role, location,
// description, salary, posting date. Most job sites embed schema.org
// JobPosting data (JSON-LD) for Google; that's tried first, then per-site
// selectors, then generic page metadata. Pure function of (document, url) so
// it can be tested against saved pages.
(function (root) {
  'use strict';

  var text = function (el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  };
  var first = function (doc, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = doc.querySelector(selectors[i]);
      if (el && text(el)) return el;
    }
    return null;
  };
  var htmlToText = function (doc, html) {
    var div = doc.createElement('div');
    div.innerHTML = String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|h\d|div)>/gi, '\n');
    return (div.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  };
  var titleCase = function (slug) {
    return String(slug || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      })
      .trim();
  };

  function site(host) {
    if (/linkedin\.com$/.test(host)) return 'linkedin';
    if (/greenhouse\.io$/.test(host)) return 'greenhouse';
    if (/lever\.co$/.test(host)) return 'lever';
    if (/ashbyhq\.com$/.test(host)) return 'ashby';
    if (/wellfound\.com$/.test(host)) return 'wellfound';
    if (/workable\.com$/.test(host)) return 'workable';
    if (/myworkdayjobs\.com$/.test(host)) return 'workday';
    return 'web';
  }

  function jsonLdJob(doc) {
    var scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length; i++) {
      var data;
      try {
        data = JSON.parse(scripts[i].textContent || '');
      } catch (e) {
        continue;
      }
      var items = Array.isArray(data) ? data : data && data['@graph'] ? data['@graph'] : [data];
      for (var j = 0; j < items.length; j++) {
        var t = items[j] && items[j]['@type'];
        if (t === 'JobPosting' || (Array.isArray(t) && t.indexOf('JobPosting') !== -1)) return items[j];
      }
    }
    return null;
  }

  function salaryFrom(base) {
    if (!base) return '';
    var v = base.value || base;
    var cur = base.currency || v.currency || '';
    var unit = (v.unitText || base.unitText || '').toLowerCase();
    var fmt = function (n) {
      return typeof n === 'number' ? n.toLocaleString('en-US') : n;
    };
    var range = v.minValue && v.maxValue ? fmt(v.minValue) + '–' + fmt(v.maxValue) : fmt(v.value || v.minValue || v.maxValue || '');
    if (!range) return '';
    return (cur + ' ' + range + (unit ? ' / ' + unit : '')).trim();
  }

  function locationFrom(job) {
    if (job.jobLocationType === 'TELECOMMUTE') return 'Remote';
    var locs = Array.isArray(job.jobLocation) ? job.jobLocation : job.jobLocation ? [job.jobLocation] : [];
    var parts = locs
      .map(function (l) {
        var a = (l && l.address) || {};
        return [a.addressLocality, a.addressRegion, typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry && a.addressCountry.name]
          .filter(Boolean)
          .join(', ');
      })
      .filter(Boolean);
    return parts.slice(0, 2).join(' / ');
  }

  // "3 weeks ago", "Reposted 2 days ago", "Posted 30+ days ago" → a date.
  function relativeDate(s, now) {
    var m = /(\d+)\+?\s*(minute|hour|day|week|month)s?\s+ago/i.exec(s || '');
    if (!m) return undefined;
    var ms = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2].toLowerCase()];
    return new Date(now - Number(m[1]) * ms).toISOString();
  }

  function extract(doc, url, now) {
    now = now || Date.now();
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    var s = site(u.hostname.replace(/^www\./, ''));
    var out = { url: url.split('#')[0], company: '', role: '', location: '', description: '', salary: '', postedAt: undefined, reposted: false, site: s };

    var job = jsonLdJob(doc);
    if (job) {
      var org = job.hiringOrganization;
      out.company = (org && (typeof org === 'string' ? org : org.name)) || '';
      out.role = job.title || '';
      out.location = locationFrom(job);
      out.description = htmlToText(doc, job.description);
      out.salary = salaryFrom(job.baseSalary);
      if (job.datePosted && !isNaN(Date.parse(job.datePosted))) out.postedAt = new Date(job.datePosted).toISOString();
    }

    var path = u.pathname.split('/').filter(Boolean);
    if (s === 'linkedin') {
      var top = first(doc, ['.job-details-jobs-unified-top-card__container--two-pane', '.jobs-unified-top-card', '.top-card-layout']);
      out.role = out.role || text(first(doc, ['.job-details-jobs-unified-top-card__job-title h1', '.jobs-unified-top-card__job-title', 'h1.top-card-layout__title', 'h1']));
      out.company = out.company || text(first(doc, ['.job-details-jobs-unified-top-card__company-name a', '.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name', '.topcard__org-name-link']));
      out.description = out.description || text(first(doc, ['#job-details', '.jobs-description__content', '.description__text']));
      // The info line: "Bengaluru, India · Reposted 3 weeks ago · 100 applicants". Shortest
      // element that looks like it (LinkedIn's class names change often).
      var meta = '';
      var candidates = (top || doc).querySelectorAll('div, span, p');
      for (var k = 0; k < candidates.length; k++) {
        var t = text(candidates[k]);
        if (t.indexOf('·') !== -1 && /ago|applicant/i.test(t) && (!meta || t.length < meta.length)) meta = t;
      }
      out.reposted = /reposted/i.test(meta);
      out.postedAt = out.postedAt || relativeDate(meta, now);
      var sal = /([$₹€£]\s?[\d,.]+[kKmM]?(?:\s*[-–]\s*[$₹€£]?\s?[\d,.]+[kKmM]?)?(?:\s*\/\s*(?:yr|year|hr|hour|month))?)/.exec(meta);
      out.salary = out.salary || (sal ? sal[1] : '');
      out.location = out.location || (meta ? meta.split('·')[0].trim() : '');
    } else if (s === 'greenhouse') {
      out.role = out.role || text(first(doc, ['h1.app-title', '.job__title h1', 'h1']));
      out.company = out.company || text(first(doc, ['.company-name', '.job__header .company'])).replace(/^at\s+/i, '') || titleCase(path[0]);
      out.location = out.location || text(first(doc, ['.location', '.job__location']));
      out.description = out.description || text(first(doc, ['#content', '.job__description']));
    } else if (s === 'lever') {
      out.role = out.role || text(first(doc, ['.posting-headline h2', 'h2']));
      out.company = out.company || (doc.querySelector('.main-header-logo img') || {}).alt || titleCase(path[0]);
      out.location = out.location || text(first(doc, ['.posting-categories .location', '.sort-by-location']));
      out.description = out.description || text(first(doc, ['[data-qa="job-description"]', '.section-wrapper.page-full-width']));
    } else if (s === 'ashby' || s === 'workable') {
      out.company = out.company || titleCase(path[0]);
      out.role = out.role || text(first(doc, ['h1']));
    }

    // Generic fallbacks: page title "Role at Company", og tags, the first h1.
    var og = function (p) {
      var el = doc.querySelector('meta[property="og:' + p + '"]');
      return el ? el.getAttribute('content') || '' : '';
    };
    var title = og('title') || (doc.title || '');
    var at = /^(.+?)\s+(?:at|@|-|–|\|)\s+(.+?)(?:\s*[|–-].*)?$/.exec(title);
    out.role = out.role || (at ? at[1] : text(first(doc, ['h1'])) || title);
    out.company = out.company || (at ? at[2] : og('site_name'));

    out.company = out.company.replace(/\s*(careers|jobs)\s*$/i, '').trim().slice(0, 100);
    out.role = out.role.replace(/\s+/g, ' ').trim().slice(0, 150);
    out.location = out.location.trim().slice(0, 150);
    out.description = out.description.slice(0, 30000);
    return out;
  }

  root.mailtrackExtract = extract;
})(typeof window !== 'undefined' ? window : globalThis);
