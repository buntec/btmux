import { useEffect, useMemo } from 'react';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { buildSyntaxStyle } from '../syntax-theme';
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
import { useFileStore } from '@/state/fileStore';
import { useStore } from '@/state/store';

SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('c', c);
SyntaxHighlighter.registerLanguage('cpp', cpp);
SyntaxHighlighter.registerLanguage('css', css);
SyntaxHighlighter.registerLanguage('dockerfile', dockerfile);
SyntaxHighlighter.registerLanguage('go', go);
SyntaxHighlighter.registerLanguage('ini', ini);
SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('kotlin', kotlin);
SyntaxHighlighter.registerLanguage('lua', lua);
SyntaxHighlighter.registerLanguage('makefile', makefile);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('nix', nix);
SyntaxHighlighter.registerLanguage('php', php);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('ruby', ruby);
SyntaxHighlighter.registerLanguage('rust', rust);
SyntaxHighlighter.registerLanguage('scala', scala);
SyntaxHighlighter.registerLanguage('scss', scss);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('swift', swift);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('xml', xml);
SyntaxHighlighter.registerLanguage('yaml', yaml);

const MAX_HIGHLIGHT_BYTES = 20 * 1024;
const MAX_LINES = 5000;

const LANGUAGE_MAP: Record<string, string> = {
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  java: 'java',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  toml: 'ini',
  yaml: 'yaml',
  yml: 'yaml',
  html: 'xml',
  css: 'css',
  scss: 'scss',
  sql: 'sql',
  xml: 'xml',
  vue: 'xml',
  svelte: 'xml',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  lua: 'lua',
  nix: 'nix',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  json: 'json',
  md: 'markdown',
};

export function CodePreview() {
  const fileContent = useFileStore((s) => s.fileContent);
  const selectedFile = useFileStore((s) => s.selectedFile);
  const searchMode = useFileStore((s) => s.searchMode);
  const searchQuery = useFileStore((s) => s.searchQuery);
  const contentSearchResults = useFileStore((s) => s.contentSearchResults);
  const focusedIndex = useFileStore((s) => s.focusedIndex);
  const theme = useStore((s) => s.config?.theme ?? null);

  if (!fileContent) return null;

  const ext = selectedFile?.split('.').pop()?.toLowerCase() || '';
  const language = LANGUAGE_MAP[ext] || 'plaintext';

  const style = useMemo(() => (theme ? buildSyntaxStyle(theme) : atomOneDark), [theme]);

  const { text, lineTruncated } = useMemo(() => {
    const lines = fileContent.content.split('\n');
    if (lines.length > MAX_LINES) {
      return {
        text: lines.slice(0, MAX_LINES).join('\n'),
        lineTruncated: true,
      };
    }
    return { text: fileContent.content, lineTruncated: false };
  }, [fileContent.content]);

  // When in content search mode, highlight the focused result's line
  const targetLine = useMemo(() => {
    if (searchMode !== 'content') return null;
    const result = contentSearchResults[focusedIndex];
    if (!result || result.path !== selectedFile) return null;
    return result.line ?? null;
  }, [searchMode, contentSearchResults, focusedIndex, selectedFile]);

  // Scroll target line into the centre of the preview viewport
  useEffect(() => {
    if (targetLine == null) return;
    const scrollArea = document.querySelector('.file-preview-scroll [data-slot="scroll-area-viewport"]');
    if (!scrollArea) return;
    // SyntaxHighlighter renders one <span> block per line, or we can use the
    // data-line attribute injected via lineProps. Fall back to a rough estimate.
    const lineEl = scrollArea.querySelector(`[data-line="${targetLine}"]`);
    if (lineEl) {
      lineEl.scrollIntoView({ block: 'center' });
    } else {
      // Estimate line height from the pre element
      const pre = scrollArea.querySelector('pre');
      if (!pre) return;
      const lineHeight = pre.scrollHeight / (text.split('\n').length || 1);
      const offset = (targetLine - 1) * lineHeight;
      scrollArea.scrollTop = Math.max(0, offset - scrollArea.clientHeight / 2);
    }
  }, [targetLine, text]);

  const useHighlighting = text.length <= MAX_HIGHLIGHT_BYTES;
  const bg = theme?.background ?? '#282c34';
  const fg = theme?.foreground ?? '#abb2bf';

  return (
    <div>
      {useHighlighting ? (
        <SyntaxHighlighter
          language={language}
          style={style}
          showLineNumbers
          customStyle={{
            margin: 0,
            borderRadius: '0.5rem',
            fontSize: '1em',
          }}
          lineProps={(lineNumber) => {
            const isTarget = targetLine != null && lineNumber === targetLine;
            return {
              'data-line': lineNumber,
              style: {
                display: 'block',
                ...(isTarget && {
                  backgroundColor: 'rgba(255,220,0,0.15)',
                  boxShadow: 'inset 2px 0 0 rgba(255,220,0,0.7)',
                }),
              },
            } as React.HTMLAttributes<HTMLElement> & { 'data-line': number };
          }}
          wrapLines
        >
          {text}
        </SyntaxHighlighter>
      ) : (
        <pre className="rounded-lg p-4 overflow-x-auto" style={{ background: bg, color: fg }}>
          <code>{text}</code>
        </pre>
      )}
      {(lineTruncated || fileContent.truncated) && (
        <div className="mt-2 rounded bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          Preview truncated ({formatSize(fileContent.size)} total)
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
