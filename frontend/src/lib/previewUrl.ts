// A path URL, so the page's relative links and assets resolve. A UNC path's
// `//` goes in its first segment, where those links can't resolve it away.
export function previewUrl(path: string): string {
  const unixPath = path.startsWith('/') ? path : path.replace(/\\/g, '/');
  const root = unixPath.startsWith('//') ? '%2F%2F' : '';
  const segments = unixPath.split('/').filter(Boolean).map(encodeURIComponent);
  return `/api/preview/${root}${segments.join('/')}`;
}
