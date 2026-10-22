# Mailtrack Chrome extension

- **Save to Mailtrack** on job pages (LinkedIn, Greenhouse, Lever, Ashby, Wellfound, Workable, Workday): reads the company, role, location, description, salary and posting date, and saves the job to your pipeline's Wishlist. On any other page, click the toolbar icon.
- **Ignores your own opens**: when Gmail shows one of your tracked emails, the tracking pixel is blanked and the server is told it's you.

Install: `chrome://extensions` → Developer mode → Load unpacked → this `extension/` folder. After an update, click the reload icon on the extension card. Stay signed in to track.shotline.in in the same Chrome profile (saving uses that session).

Reading the page: `extract.js` tries schema.org JobPosting data first (most job sites publish it for Google), then per-site selectors, then the page title. Tests: `extension/extract.test.ts`.
