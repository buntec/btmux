import type { Theme } from '../state/types';

export function applyThemeVars(theme: Theme | null): void {
  const root = document.documentElement;

  if (!theme) {
    root.classList.add('dark');
    removeThemeVars(root);
    return;
  }

  root.classList.add('dark');

  const vars: Record<string, string> = {
    '--background': theme.background,
    '--foreground': theme.foreground,
    '--card': theme.black,
    '--card-foreground': theme.foreground,
    '--popover': theme.black,
    '--popover-foreground': theme.foreground,
    '--primary': theme.blue,
    '--primary-foreground': theme.background,
    '--secondary': theme.black,
    '--secondary-foreground': theme.foreground,
    '--muted': theme.black,
    '--muted-foreground': theme.brightBlack,
    '--accent': theme.selectionBackground,
    '--accent-foreground': theme.foreground,
    '--destructive': theme.red,
    '--border': theme.brightBlack,
    '--input': theme.brightBlack,
    '--ring': theme.blue,
    '--sidebar': theme.black,
    '--sidebar-foreground': theme.foreground,
    '--sidebar-primary': theme.blue,
    '--sidebar-primary-foreground': theme.background,
    '--sidebar-accent': theme.selectionBackground,
    '--sidebar-accent-foreground': theme.foreground,
    '--sidebar-border': theme.brightBlack,
    '--sidebar-ring': theme.blue,
    '--color-red': theme.red,
    '--color-orange': theme.yellow,
    '--color-yellow': theme.brightYellow,
    '--color-green': theme.green,
    '--color-cyan': theme.cyan,
    '--color-blue': theme.blue,
    '--color-magenta': theme.magenta,
    '--color-brown': theme.brightBlack,
  };

  for (const [prop, value] of Object.entries(vars)) {
    root.style.setProperty(prop, value);
  }
}

const THEME_VARS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--border',
  '--input',
  '--ring',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
  '--color-red',
  '--color-orange',
  '--color-yellow',
  '--color-green',
  '--color-cyan',
  '--color-blue',
  '--color-magenta',
  '--color-brown',
];

function removeThemeVars(root: HTMLElement): void {
  for (const prop of THEME_VARS) {
    root.style.removeProperty(prop);
  }
}
