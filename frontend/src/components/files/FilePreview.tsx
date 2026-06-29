import { ScrollArea } from '@/components/ui/scroll-area';
import { useFileStore } from '@/state/fileStore';

export function FilePreview() {
  const fileContent = useFileStore((s) => s.fileContent);
  const selectedFile = useFileStore((s) => s.selectedFile);
  const isLoading = useFileStore((s) => s.isLoading);

  if (isLoading) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">Loading...</div>;
  }

  if (!selectedFile || !fileContent) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
        Select a file to preview
      </div>
    );
  }

  const isImage =
    fileContent.mime_type.startsWith('image/') && fileContent.encoding === 'base64';

  if (isImage) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <img
          src={`data:${fileContent.mime_type};base64,${fileContent.content}`}
          alt={selectedFile}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    );
  }

  if (fileContent.encoding === 'base64') {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
        Binary file ({fileContent.mime_type}, {formatSize(fileContent.size)})
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <pre className="p-3 text-xs leading-relaxed whitespace-pre-wrap break-all font-mono text-foreground">
        {fileContent.content}
        {fileContent.truncated && (
          <span className="text-muted-foreground">{'\n\n'}[truncated]</span>
        )}
      </pre>
    </ScrollArea>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
