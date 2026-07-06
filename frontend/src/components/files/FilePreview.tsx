import { ScrollArea } from '@/components/ui/scroll-area';
import { useFileStore } from '@/state/fileStore';
import { CodePreview } from './previews/CodePreview';
import { MarkdownPreview } from './previews/MarkdownPreview';
import { JsonPreview } from './previews/JsonPreview';
import { CsvPreview } from './previews/CsvPreview';
import { DiffPreview } from './previews/DiffPreview';
import { MediaPreview } from './previews/MediaPreview';
import { PdfPreview } from './previews/PdfPreview';
import { DirectoryPreview } from './previews/DirectoryPreview';

type PreviewType =
  | 'code'
  | 'image'
  | 'markdown'
  | 'json'
  | 'csv'
  | 'diff'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'directory'
  | 'unknown';

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

  pdf: 'pdf',

  mp4: 'video',
  webm: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  ogv: 'video',

  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  flac: 'audio',
  m4a: 'audio',
  aac: 'audio',
  wma: 'audio',
};

function getPreviewType(path: string, mimeType: string): PreviewType {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const mapped = EXTENSION_MAP[ext];
  if (mapped) return mapped;

  if (mimeType.startsWith('text/')) return 'code';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'application/pdf') return 'pdf';

  return 'unknown';
}

export function FilePreview() {
  const fileContent = useFileStore((s) => s.fileContent);
  const selectedFile = useFileStore((s) => s.selectedFile);
  const isLoading = useFileStore((s) => s.isLoading);
  const isGitMode = useFileStore((s) => s.isGitMode);
  const gitDiff = useFileStore((s) => s.gitDiff);
  const directoryTree = useFileStore((s) => s.directoryTree);
  const searchMode = useFileStore((s) => s.searchMode);

  if (isGitMode && gitDiff) {
    return <DiffPreview />;
  }

  if (directoryTree) {
    return <DirectoryPreview tree={directoryTree} />;
  }

  if (isLoading) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">Loading...</div>;
  }

  if (!selectedFile || !fileContent) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">Select a file to preview</div>
    );
  }

  const previewType = getPreviewType(selectedFile, fileContent.mime_type);

  if (previewType === 'pdf') {
    return <PdfPreview />;
  }

  if (previewType === 'video' || previewType === 'audio') {
    return <MediaPreview />;
  }

  if (previewType === 'image') {
    if (fileContent.mime_type === 'image/svg+xml' && fileContent.encoding === 'utf-8') {
      return (
        <ScrollArea className="flex-1 overflow-hidden">
          <div className="flex items-center justify-center p-4">
            <div dangerouslySetInnerHTML={{ __html: sanitizeSvg(fileContent.content) }} />
          </div>
        </ScrollArea>
      );
    }

    const src =
      fileContent.encoding === 'base64' ? `data:${fileContent.mime_type};base64,${fileContent.content}` : undefined;

    if (!src) {
      return <div className="flex-1 flex items-center justify-center text-muted-foreground">Cannot preview image</div>;
    }

    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <img src={src} alt={selectedFile} className="max-w-full max-h-full object-contain" />
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
    <ScrollArea className="flex-1 overflow-hidden">
      <div className="p-4">
        {searchMode === 'content' ? (
          <CodePreview />
        ) : (
          <>
            {previewType === 'code' && <CodePreview />}
            {previewType === 'markdown' && <MarkdownPreview />}
            {previewType === 'json' && <JsonPreview />}
            {previewType === 'csv' && <CsvPreview />}
            {previewType === 'unknown' && (
              <pre className="leading-relaxed whitespace-pre-wrap break-all font-mono text-foreground text-sm">
                {fileContent.content}
                {fileContent.truncated && <span className="text-muted-foreground">{'\n\n'}[truncated]</span>}
              </pre>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

function sanitizeSvg(raw: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'image/svg+xml');
  doc.querySelectorAll('script').forEach((el) => el.remove());
  doc.querySelectorAll('[onload],[onerror],[onclick],[onmouseover]').forEach((el) => {
    el.removeAttribute('onload');
    el.removeAttribute('onerror');
    el.removeAttribute('onclick');
    el.removeAttribute('onmouseover');
  });
  doc.querySelectorAll('foreignObject').forEach((el) => el.remove());
  return doc.documentElement.outerHTML;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
