import type { CSSProperties } from 'react';
import type { Theme } from '../../state/types';

type HljsStyle = Record<string, CSSProperties>;

/**
 * Maps btmux's Theme (ANSI palette from base16/24 translation) to hljs token
 * styles. The ANSI colors correspond to base16 roles:
 *   red=base08, green=base0B, yellow=base0A, blue=base0D,
 *   magenta=base0E, cyan=base0C, brightBlack=base03, brightRed=base09
 */
export function buildSyntaxStyle(theme: Theme): HljsStyle {
  return {
    'hljs': {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: theme.background,
      color: theme.foreground,
    },
    'hljs-comment': { color: theme.brightBlack },
    'hljs-quote': { color: theme.brightBlack },
    'hljs-variable': { color: theme.red },
    'hljs-template-variable': { color: theme.red },
    'hljs-tag': { color: theme.red },
    'hljs-name': { color: theme.red },
    'hljs-selector-id': { color: theme.red },
    'hljs-selector-class': { color: theme.red },
    'hljs-regexp': { color: theme.cyan },
    'hljs-deletion': { color: theme.red },
    'hljs-number': { color: theme.brightRed },
    'hljs-built_in': { color: theme.brightRed },
    'hljs-literal': { color: theme.brightRed },
    'hljs-type': { color: theme.yellow },
    'hljs-params': { color: theme.foreground },
    'hljs-meta': { color: theme.brightMagenta },
    'hljs-link': { color: theme.brightRed },
    'hljs-attribute': { color: theme.yellow },
    'hljs-string': { color: theme.green },
    'hljs-symbol': { color: theme.green },
    'hljs-bullet': { color: theme.green },
    'hljs-addition': { color: theme.green },
    'hljs-title': { color: theme.blue },
    'hljs-section': { color: theme.blue },
    'hljs-keyword': { color: theme.magenta },
    'hljs-selector-tag': { color: theme.magenta },
    'hljs-subst': { color: theme.foreground },
    'hljs-emphasis': { fontStyle: 'italic' },
    'hljs-strong': { fontWeight: 'bold' },
  };
}
