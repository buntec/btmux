import { Folder, File } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { TreeNode } from '@/protocol/file-messages';

interface DirectoryPreviewProps {
  tree: TreeNode;
}

export function DirectoryPreview({ tree }: DirectoryPreviewProps) {
  return (
    <ScrollArea className="flex-1 overflow-hidden">
      <div className="p-4 font-mono text-sm">
        <TreeNodeRow node={tree} depth={0} />
      </div>
    </ScrollArea>
  );
}

function TreeNodeRow({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 py-px" style={{ paddingLeft: `${depth * 16}px` }}>
        {node.is_dir ? (
          <Folder className="size-3.5 text-theme-blue shrink-0" />
        ) : (
          <File className="size-3.5 text-muted-foreground shrink-0" />
        )}
        <span className={node.is_dir ? 'text-theme-blue' : 'text-foreground'}>{node.name}</span>
      </div>
      {node.children?.map((child) => (
        <TreeNodeRow key={child.name} node={child} depth={depth + 1} />
      ))}
      {node.truncated && (
        <div className="text-muted-foreground italic py-px" style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
          ...
        </div>
      )}
    </div>
  );
}
