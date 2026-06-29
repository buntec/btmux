import { ScrollArea } from '@/components/ui/scroll-area';
import { useFileStore } from '@/state/fileStore';
import { CodePreview } from './previews/CodePreview';
import { MarkdownPreview } from './previews/MarkdownPreview';
import { JsonPreview } from './previews/JsonPreview';
import { CsvPreview } from './previews/CsvPreview';
import { DiffPreview } from './previews/DiffPreview';

type PreviewType = 'code' | 'image' | 'markdown' | 'json' | 'csv' | 'diff' | 'unknown';

const EXTENSION_MAP: Record<string, PreviewType> = {
  rs: 'code',
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  py: 'code',
  go: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  java: 'code',
  rb: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  toml: 'code',
  yaml: 'code',
  yml: 'code',
  html: 'code',
  css: 'code',
  scss: 'code',
  sql: 'code',
  txt: 'code',
  xml: 'code',
  vue: 'code',
  svelte: 'code',
  php: 'code',
  swift: 'code',
  kt: 'code',
  scala: 'code',
  zig: 'code',
  nix: 'code',
  lua: 'code',
  vim: 'code',
  fish: 'code',
  dockerfile: 'code',
  makefile: 'code',
  gitignore: 'code',
  env: 'code',
  lock: 'code',
  log: 'code',

  md: 'markdown',
  mdx: 'markdown',

  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  ico: 'image',
  bmp: 'image',

  csv: 'csv',
  tsv: 'csv',
  json: 'json',
  jsonl: 'json',
};

function getPreviewType(path: string, mimeType: string): PreviewType {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const mapped = EXTENSION_MAP[ext];
  if (mapped) return mapped;

  if (mimeType.startsWith('text/')) return 'code';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/json') return 'json';

  return 'unknown';
}

export function FilePreview() {
  const fileContent = useFileStore((s) => s.fileContent);
  const selectedFile = useFileStore((s) => s.selectedFile);
  const isLoading = useFileStore((s) => s.isLoading);
  const isGitMode = useFileStore((s) => s.isGitMode);
  const gitDiff = useFileStore((s) => s.gitDiff);

  if (isGitMode && gitDiff) {
    return <DiffPreview />;
  }

  if (isLoading) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>;
  }

  if (!selectedFile || !fileContent) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Select a file to preview
      </div>
    );
  }

  const previewType = getPreviewType(selectedFile, fileContent.mime_type);

  if (previewType === 'image') {
    if (fileContent.mime_type === 'image/svg+xml' && fileContent.encoding === 'utf-8') {
      return (
        <ScrollArea className="flex-1">
          <div className="flex items-center justify-center p-4">
            <div dangerouslySetInnerHTML={{ __html: fileContent.content }} />
          </div>
        </ScrollArea>
      );
    }

    const src =
      fileContent.encoding === 'base64'
        ? `data:${fileContent.mime_type};base64,${fileContent.content}`
        : undefined;

    if (!src) {
      return (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Cannot preview image
        </div>
      );
    }

    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <img
          src={src}
          alt={selectedFile}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    );
  }

  if (fileContent.encoding === 'base64') {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Binary file ({fileContent.mime_type}, {formatSize(fileContent.size)})
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="p-4">
        {previewType === 'code' && <CodePreview />}
        {previewType === 'markdown' && <MarkdownPreview />}
        {previewType === 'json' && <JsonPreview />}
        {previewType === 'csv' && <CsvPreview />}
        {previewType === 'unknown' && (
          <pre className="leading-relaxed whitespace-pre-wrap break-all font-mono text-foreground text-sm">
            {fileContent.content}
            {fileContent.truncated && (
              <span className="text-muted-foreground">{'\n\n'}[truncated]</span>
            )}
          </pre>
        )}
      </div>
    </ScrollArea>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
