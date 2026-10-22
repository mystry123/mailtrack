// Minimal stroke icons (24px grid, currentColor).
const PATHS: Record<string, string> = {
  today: 'M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  pipeline: 'M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z',
  sent: 'M4 12l16-8-6 16-3-7-7-1z',
  insights: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z',
  link: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7',
  plus: 'M12 5v14M5 12h14',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  reply: 'M9 17l-5-5 5-5M4 12h11a5 5 0 015 5v2',
  fire: 'M12 22c4 0 7-3 7-7 0-5-4-6-5-11-2 2-3 4-3 6-1-1-2-2-2-4-2 2-4 5-4 9 0 4 3 7 7 7z',
  calendar: 'M4 5h16v16H4zM4 9h16M8 3v4M16 3v4',
  ghost: 'M5 21V10a7 7 0 0114 0v11l-2.5-2-2.5 2-2-2-2 2-2.5-2zM9 10h.01M15 10h.01',
  check: 'M5 12l5 5L20 7',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
