import type { CSSProperties } from 'react';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/hljs/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/hljs/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/hljs/cpp';
import css from 'react-syntax-highlighter/dist/esm/languages/hljs/css';
import dockerfile from 'react-syntax-highlighter/dist/esm/languages/hljs/dockerfile';
import go from 'react-syntax-highlighter/dist/esm/languages/hljs/go';
import ini from 'react-syntax-highlighter/dist/esm/languages/hljs/ini';
import java from 'react-syntax-highlighter/dist/esm/languages/hljs/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/hljs/kotlin';
import lua from 'react-syntax-highlighter/dist/esm/languages/hljs/lua';
import makefile from 'react-syntax-highlighter/dist/esm/languages/hljs/makefile';
import markdown from 'react-syntax-highlighter/dist/esm/languages/hljs/markdown';
import nix from 'react-syntax-highlighter/dist/esm/languages/hljs/nix';
import php from 'react-syntax-highlighter/dist/esm/languages/hljs/php';
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/hljs/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/hljs/rust';
import scala from 'react-syntax-highlighter/dist/esm/languages/hljs/scala';
import scss from 'react-syntax-highlighter/dist/esm/languages/hljs/scss';
import sql from 'react-syntax-highlighter/dist/esm/languages/hljs/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/hljs/swift';
import typescript from 'react-syntax-highlighter/dist/esm/languages/hljs/typescript';
import xml from 'react-syntax-highlighter/dist/esm/languages/hljs/xml';
import yaml from 'react-syntax-highlighter/dist/esm/languages/hljs/yaml';
import type { Theme } from '../state/types';

const LANGUAGES = {
  bash,
  c,
  cpp,
  css,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  makefile,
  markdown,
  nix,
  php,
  python,
  ruby,
  rust,
  scala,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) SyntaxHighlighter.registerLanguage(name, language);

/** File extensions and Markdown fence names (LSP language IDs) the registered names don't cover. */
const ALIASES: Record<string, string> = {
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  typescriptreact: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascriptreact: 'javascript',
  py: 'python',
  h: 'c',
  cc: 'cpp',
  hpp: 'cpp',
  'c++': 'cpp',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  fish: 'bash',
  toml: 'ini',
  yml: 'yaml',
  html: 'xml',
  vue: 'xml',
  svelte: 'xml',
  kt: 'kotlin',
  jsonc: 'json',
  md: 'markdown',
};

/** The registered highlight.js language for a file extension or fence name, else `plaintext`. */
export function syntaxLanguage(name: string): string {
  const key = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LANGUAGES, key)) return key;
  return ALIASES[key] ?? 'plaintext';
}

type HljsStyle = Record<string, CSSProperties>;

/**
 * Maps btmux's Theme (ANSI palette from base16/24 translation) to hljs token
 * styles. The ANSI colors correspond to base16 roles:
 *   red=base08, green=base0B, yellow=base0A, blue=base0D,
 *   magenta=base0E, cyan=base0C, brightBlack=base03, brightRed=base09
 */
export function buildSyntaxStyle(theme: Theme): HljsStyle {
  return {
    hljs: {
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
