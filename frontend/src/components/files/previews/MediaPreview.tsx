import { useFileStore } from '@/state/fileStore';

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma']);

function getMediaType(path: string): 'video' | 'audio' | null {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return null;
}

export function MediaPreview() {
  const selectedFile = useFileStore((s) => s.selectedFile);

  if (!selectedFile) return null;

  const mediaType = getMediaType(selectedFile);
  const src = `/api/file?path=${encodeURIComponent(selectedFile)}`;

  if (mediaType === 'video') {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <video
          src={src}
          controls
          className="max-w-full max-h-full rounded-lg"
        />
      </div>
    );
  }

  if (mediaType === 'audio') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
        <div className="text-muted-foreground text-sm">
          {selectedFile.split('/').pop()}
        </div>
        <audio src={src} controls className="w-full max-w-md" />
      </div>
    );
  }

  return null;
}
