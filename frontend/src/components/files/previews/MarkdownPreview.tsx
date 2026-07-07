import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useFileStore } from '@/state/fileStore';

export function MarkdownPreview() {
  const fileContent = useFileStore((s) => s.fileContent);
  if (!fileContent) return null;

  return (
    <div className="prose dark:prose-invert max-w-none" style={{ fontSize: '1em' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{fileContent.content}</ReactMarkdown>
    </div>
  );
}
