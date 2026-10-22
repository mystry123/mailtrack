// Light by default, like Shotline; the choice is remembered per browser.
export type Theme = 'light' | 'dark';
const KEY = 'mt-theme';

export function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private mode: just not remembered
  }
}
