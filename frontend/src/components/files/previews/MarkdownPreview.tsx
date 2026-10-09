import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useFileStore } from '@/state/fileStore';

// Wrap fenced code blocks and keep long inline tokens from overflowing.
const WRAP_CODE = '[&_pre]:whitespace-pre-wrap [&_pre_code]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]';

export function MarkdownPreview() {
  const fileContent = useFileStore((s) => s.fileContent);
  const wrapLines = useFileStore((s) => s.wrapLines);
  if (!fileContent) return null;

  return (
    <div className={`prose dark:prose-invert max-w-none ${wrapLines ? WRAP_CODE : ''}`} style={{ fontSize: '1em' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent.content}</ReactMarkdown>
    </div>
  );
}
