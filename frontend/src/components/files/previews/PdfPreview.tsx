import { useFileStore } from '@/state/fileStore';

export function PdfPreview() {
  const selectedFile = useFileStore((s) => s.selectedFile);

  if (!selectedFile) return null;

  const src = `/api/file?path=${encodeURIComponent(selectedFile)}`;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <iframe
        src={src}
        className="flex-1 w-full border-0 rounded-lg bg-white"
        title={selectedFile.split('/').pop() ?? 'PDF'}
      />
    </div>
  );
}
