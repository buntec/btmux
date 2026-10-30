import { useId, type SVGProps } from 'react';
import { SquarePen } from 'lucide-react';
import type { Editor } from '../generated/protocol';

// Neovim mark from neovim.io, VS Code from Codicons; see third-party/*/NOTICE.
// Sized in em: WebKit collapses an unsized SVG flex item to 0x0.
function NeovimGlyph(props: SVGProps<SVGSVGElement>) {
  const id = useId();
  // The mark's gradients in shades of currentColor.
  const gradient = (name: string, top: number, bottom: number) => (
    <linearGradient id={`${id}${name}`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="currentColor" stopOpacity={top} />
      <stop offset="1" stopColor="currentColor" stopOpacity={bottom} />
    </linearGradient>
  );
  return (
    <svg viewBox="-66 0 734 734" width="1em" height="1em" {...props}>
      <defs>
        {gradient('left', 0.55, 0.85)}
        {gradient('right', 0.6, 1)}
        {gradient('cross', 0.5, 0.75)}
      </defs>
      <g transform="translate(2 3)" fillRule="evenodd">
        <path fill={`url(#${id}left)`} d="M0 155.57 155-1v728L0 572.238z" />
        <path
          fill={`url(#${id}right)`}
          transform="translate(521 363.5) scale(-1 1) translate(-521 -363.5)"
          d="M443.06 156.982 600-1l-3.181 728L442 572.22z"
        />
        <path fill={`url(#${id}cross)`} d="M154.986 0 558 615.19 445.225 728 42 114.172z" />
        <path fill="currentColor" fillOpacity={0.13} d="m155 283.832-.213 24.168L31 124.711 42.462 113z" />
      </g>
    </svg>
  );
}

function VscodeGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" {...props}>
      <path d="M15.434 1.72887L12.14 0.144875C12.002 0.078875 11.855 0.046875 11.709 0.046875C11.353 0.046875 11.18 0.211875 11.155 0.228875C11.073 0.270875 11.005 0.337875 11.004 0.338875L4.698 6.08888L1.951 4.00488C1.832 3.91388 1.69 3.86987 1.548 3.86987C1.387 3.86987 1.226 3.92788 1.1 4.04288L0.219 4.84387C0.074 4.97587 0.001 5.15688 0.001 5.33687C0.001 5.51687 0.073 5.69688 0.218 5.82888L2.6 8.00088L0.217 10.1719C0.072 10.3039 0 10.4839 0 10.6639C0 10.8439 0.073 11.0249 0.218 11.1569L1.099 11.9579C1.226 12.0729 1.386 12.1309 1.547 12.1309C1.688 12.1309 1.83 12.0859 1.95 11.9959L4.697 9.91187L11.003 15.6619C11.003 15.6619 11.072 15.7299 11.155 15.7719C11.179 15.7889 11.353 15.9529 11.709 15.9529C11.855 15.9529 12.003 15.9209 12.141 15.8549L15.435 14.2709C15.781 14.1049 16.001 13.7539 16.001 13.3699V2.62888C16.001 2.24487 15.781 1.89488 15.435 1.72787L15.434 1.72887ZM7.217 7.99988L12.002 4.36987V11.6299L7.217 7.99988Z" />
    </svg>
  );
}

/** Button label and icon for an editor. */
export function editorButton(editor: Editor | undefined) {
  if (editor === 'vscode') return { label: 'VS Code', icon: <VscodeGlyph /> };
  if (editor === 'pane') return { label: 'Editor', icon: <SquarePen /> };
  return { label: 'Neovim', icon: <NeovimGlyph /> };
}

/** The toolbar's editors: the configured one, then the others the server can run. */
export function toolbarEditors(editor: Editor | undefined, available: Editor[] | undefined): Editor[] {
  const first = editor ?? 'neovim';
  return [first, ...(available ?? []).filter((other) => other !== first)];
}
