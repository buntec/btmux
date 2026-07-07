import { useState, useMemo } from 'react';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { buildSyntaxStyle } from '../syntax-theme';
import json from 'react-syntax-highlighter/dist/esm/languages/hljs/json';
import { useFileStore } from '@/state/fileStore';
import { useStore } from '@/state/store';

SyntaxHighlighter.registerLanguage('json', json);

const MAX_HIGHLIGHT_BYTES = 20 * 1024;
const MAX_LINES = 5000;

export function JsonPreview() {
  const fileContent = useFileStore((s) => s.fileContent);
  const theme = useStore((s) => s.config?.theme ?? null);
  const [expanded, setExpanded] = useState(true);

  if (!fileContent) return null;

  const style = useMemo(() => (theme ? buildSyntaxStyle(theme) : atomOneDark), [theme]);

  const { text, lineTruncated } = useMemo(() => {
    let formatted: string;
    try {
      const parsed = JSON.parse(fileContent.content);
      formatted = JSON.stringify(parsed, null, expanded ? 2 : undefined);
    } catch {
      formatted = fileContent.content;
    }
    const lines = formatted.split('\n');
    if (lines.length > MAX_LINES) {
      return {
        text: lines.slice(0, MAX_LINES).join('\n'),
        lineTruncated: true,
      };
    }
    return { text: formatted, lineTruncated: false };
  }, [fileContent.content, expanded]);

  const useHighlighting = text.length <= MAX_HIGHLIGHT_BYTES;
  const bg = theme?.background ?? '#282c34';
  const fg = theme?.foreground ?? '#abb2bf';

  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button onClick={() => setExpanded(!expanded)} className="rounded px-2 py-1 text-xs hover:bg-accent">
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {useHighlighting ? (
        <SyntaxHighlighter
          language="json"
          style={style}
          showLineNumbers
          customStyle={{
            margin: 0,
            borderRadius: '0.5rem',
            fontSize: '1em',
          }}
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
