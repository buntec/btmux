import { useEffect, useMemo } from 'react';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { buildSyntaxStyle, syntaxLanguage } from '@/lib/syntax';
import { useFileStore } from '@/state/fileStore';
import { useStore } from '@/state/store';

const MAX_HIGHLIGHT_BYTES = 100 * 1024;
const MAX_LINES = 5000;

export function CodePreview() {
  const fileContent = useFileStore((s) => s.fileContent);
  const selectedFile = useFileStore((s) => s.selectedFile);
  const searchMode = useFileStore((s) => s.searchMode);
  const contentSearchResults = useFileStore((s) => s.contentSearchResults);
  const focusedIndex = useFileStore((s) => s.focusedIndex);
  const wrapLines = useFileStore((s) => s.wrapLines);
  const theme = useStore((s) => s.config?.theme ?? null);

  if (!fileContent) return null;

  const ext = selectedFile?.split('.').pop()?.toLowerCase() || '';
  const language = syntaxLanguage(ext);

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
    const scrollArea = document.querySelector('.file-preview-scroll [data-preview-viewport]');
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
            ...(wrapLines && { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }),
          }}
          codeTagProps={wrapLines ? { style: { whiteSpace: 'pre-wrap' } } : undefined}
          lineProps={(lineNumber) => {
            const isTarget = targetLine != null && lineNumber === targetLine;
            return {
              'data-line': lineNumber,
              style: {
                display: 'block',
                ...(wrapLines && { whiteSpace: 'pre-wrap' }),
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
        <pre
          className={`rounded-lg p-4 ${wrapLines ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'overflow-x-auto'}`}
          style={{ background: bg, color: fg }}
        >
          <code>{text}</code>
        </pre>
      )}
      {(lineTruncated || fileContent.truncated) && (
        <div className="mt-2 rounded bg-muted px-3 py-1.5 text-xs text-secondary">
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
