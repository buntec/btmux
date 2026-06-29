import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useFileStore } from '@/state/fileStore';

export function MarkdownPreview() {
  const fileContent = useFileStore((s) => s.fileContent);
  if (!fileContent) return null;

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {fileContent.content}
      </ReactMarkdown>
    </div>
  );
}
