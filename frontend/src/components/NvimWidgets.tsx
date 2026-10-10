import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Card } from '@astryxdesign/core/Card';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { Token } from '@astryxdesign/core/Token';
import { IconButton } from '@astryxdesign/core/IconButton';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Spinner } from '@astryxdesign/core/Spinner';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { floatFrameZ, type FloatFrame, type NvimGrid } from '../lib/nvimGrid';
import type {
  Chunk,
  Cmdline,
  KindIcons,
  Message,
  MessageLevel,
  OutputPanel,
  Popupmenu,
  Progress,
  SignatureHelp,
  WidgetState,
} from '../lib/nvimWidgets';

const FIRSTC_LABELS: Record<string, string> = {
  ':': 'Command',
  '/': 'Search',
  '?': 'Search back',
  '=': 'Expression',
  '>': 'Debug',
  '@': 'Input',
};

/** Rows shown before the popupmenu scrolls. */
const MENU_ROWS = 10;

interface Props {
  state: WidgetState;
  grid: NvimGrid;
  onSelect: (index: number) => void;
  onDismissPanel: () => void;
  /** Called when the earliest toast or finished progress card expires. */
  onExpire: () => void;
  /** 'pumblend', 0–100. */
  pumblend: number;
}

/** Gap kept above the bottom row (the statusline, since `ext_messages` sets 'cmdheight' to 0). */
const STATUSLINE_GAP = 8;

/** Externalized Neovim cmdline and popupmenu, drawn over the grid. */
export function NvimWidgets({ state, grid, onSelect, onDismissPanel, onExpire, pumblend }: Props) {
  const { cmdline, block, popupmenu, signature, messages, progress, panel, showmode, showcmd, kindIcons } = state;
  const cmdlineMenu = popupmenu?.grid === -1 && cmdline ? popupmenu : null;
  const gridMenu = popupmenu && popupmenu.grid !== -1 ? popupmenu : null;
  // The canvas can extend below the last row, so anchor to the bottom row itself.
  const bottom = `calc(100% - ${grid.cellRect(grid.rows - 1, 0).top - STATUSLINE_GAP}px)`;

  useEffect(() => {
    const times = [...messages, ...progress].map((item) => item.expires);
    if (!times.length) return;
    const id = window.setTimeout(onExpire, Math.max(0, Math.min(...times) - Date.now()) + 16);
    return () => window.clearTimeout(id);
  }, [messages, progress, onExpire]);

  return (
    <>
      {(messages.length > 0 || progress.length > 0) && (
        <VStack
          gap={1}
          hAlign="end"
          className="pointer-events-none absolute top-2 right-2 z-40"
          onMouseDown={(e) => e.preventDefault()}
        >
          {progress.map((p) => (
            <ProgressCard key={p.id} progress={p} />
          ))}
          {messages.map((m) => (
            <MessageCard key={m.key} message={m} grid={grid} />
          ))}
        </VStack>
      )}
      {(showmode.length > 0 || showcmd.length > 0) && (
        <HStack gap={1} className="pointer-events-none absolute right-2 z-40" style={{ bottom }}>
          {showmode.length > 0 && <Token size="sm" color="orange" label={chunkText(showmode)} />}
          {showcmd.length > 0 && <Token size="sm" label={chunkText(showcmd)} />}
        </HStack>
      )}
      {gridMenu && (
        <GridPopupmenu menu={gridMenu} grid={grid} kindIcons={kindIcons} onSelect={onSelect} blend={pumblend} />
      )}
      {signature && !cmdline && (
        <SignatureCard
          signature={signature}
          grid={grid}
          menuSide={gridMenu ? (menuAbove(gridMenu, grid) ? 'above' : 'below') : null}
        />
      )}
      {(cmdline || panel) && (
        // Bottom-left, just above the statusline: output panel, then cmdline completion, then the cmdline.
        <VStack
          gap={1}
          hAlign="start"
          className="pointer-events-none absolute inset-x-0 z-40 px-2"
          style={{ bottom }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {panel && <PanelCard panel={panel} grid={grid} onDismiss={onDismissPanel} />}
          {cmdlineMenu && (
            <Card
              padding={0.5}
              elevation="med"
              width="min(100%, 48rem)"
              className="pointer-events-auto"
              style={blendStyle(pumblend)}
            >
              <MenuList menu={cmdlineMenu} kindIcons={kindIcons} onSelect={onSelect} />
            </Card>
          )}
          {cmdline && <CmdlineCard cmdline={cmdline} block={block} grid={grid} />}
        </VStack>
      )}
    </>
  );
}

const chunkText = (chunks: Chunk[]) => chunks.map((c) => c.text).join('');

const DOT_VARIANTS: Record<MessageLevel, 'error' | 'warning' | 'accent'> = {
  error: 'error',
  warning: 'warning',
  info: 'accent',
};

/** A short Neovim message (echo, `vim.notify`, errors, search count, …). */
function MessageCard({ message, grid }: { message: Message; grid: NvimGrid }) {
  return (
    <Card padding={2} elevation="med" maxWidth="min(60ch, 50vw)" className="pointer-events-auto">
      <HStack gap={2} align="start">
        {/* Center the dot on the first line. */}
        <HStack align="center" className="h-lh shrink-0">
          <StatusDot label={message.level} variant={DOT_VARIANTS[message.level]} />
        </HStack>
        <Text type="code" className="min-w-0 whitespace-pre-wrap">
          <Chunks chunks={message.content} grid={grid} />
        </Text>
      </HStack>
    </Card>
  );
}

/** A progress-message: LSP work, `:write`, `vim.pack`, … */
function ProgressCard({ progress }: { progress: Progress }) {
  const title = progress.title || progress.source;
  return (
    <Card padding={2} elevation="med" width="min(40ch, 50vw)" className="pointer-events-auto">
      <VStack gap={1}>
        <HStack gap={2} vAlign="center">
          {progress.status === 'running' ? (
            <Spinner size="sm" aria-label={title} />
          ) : (
            <StatusDot
              label={progress.status}
              variant={progress.status === 'success' ? 'success' : progress.status === 'failed' ? 'error' : 'neutral'}
            />
          )}
          <Text weight="semibold" maxLines={1} className="min-w-0 flex-1">
            {title}
          </Text>
          {progress.title && progress.source && (
            <Text size="sm" color="secondary">
              {progress.source}
            </Text>
          )}
        </HStack>
        {progress.text && (
          <Text size="sm" color="secondary" maxLines={1}>
            {progress.text}
          </Text>
        )}
        {progress.percent !== null && progress.status === 'running' && (
          <ProgressBar label={title} isLabelHidden value={progress.percent} />
        )}
      </VStack>
    </Card>
  );
}

/** Multi-line output; the next normal-mode key or the close button dismisses it. */
function PanelCard({ panel, grid, onDismiss }: { panel: OutputPanel; grid: NvimGrid; onDismiss: () => void }) {
  return (
    <Card padding={2} elevation="high" width="100%" className="pointer-events-auto">
      <VStack gap={1}>
        <HStack gap={2} vAlign="center">
          <Text weight="semibold" className="flex-1">
            {panel.title}
          </Text>
          <Text size="sm" color="secondary">
            Any key to dismiss
          </Text>
          <IconButton label="Dismiss output" icon={<X />} variant="ghost" size="sm" onClick={onDismiss} />
        </HStack>
        <VStack className="max-h-80 overflow-y-auto">
          {panel.lines.map((line, i) => (
            <HStack key={i} gap={2} align="start">
              {line.level !== 'info' && (
                <HStack align="center" className="h-lh shrink-0">
                  <StatusDot label={line.level} variant={DOT_VARIANTS[line.level]} />
                </HStack>
              )}
              <Text type="code" display="block" className="min-w-0 whitespace-pre-wrap">
                <Chunks chunks={line.content} grid={grid} />
              </Text>
            </HStack>
          ))}
        </VStack>
      </VStack>
    </Card>
  );
}

/** [start, end) of the active parameter within the signature label. */
function paramRange(label: string, param: SignatureHelp['param']): [number, number] {
  if (Array.isArray(param)) return param;
  const start = param ? label.indexOf(param) : -1;
  return start < 0 || !param ? [0, 0] : [start, start + param.length];
}

/** Room the signature card needs before it prefers going above the cursor. */
const SIGNATURE_MIN_ABOVE = 160;

/** LSP signature help next to the cursor, on the side the completion menu isn't on. */
function SignatureCard({
  signature,
  grid,
  menuSide,
}: {
  signature: SignatureHelp;
  grid: NvimGrid;
  menuSide: 'above' | 'below' | null;
}) {
  const anchor = grid.cellRect(signature.row, signature.col);
  const spaceAbove = anchor.top;
  const spaceBelow = grid.cellRect(grid.rows, 0).top - anchor.top - anchor.height;
  const placeBelow = menuSide ? menuSide === 'above' : spaceAbove < SIGNATURE_MIN_ABOVE && spaceBelow > spaceAbove;
  const { label } = signature;
  const [start, end] = paramRange(label, signature.param);
  return (
    <Card
      padding={2}
      elevation="med"
      maxWidth="min(80ch, 90%)"
      className="absolute z-40 overflow-y-auto"
      onMouseDown={(e) => e.preventDefault()}
      style={
        placeBelow
          ? { left: anchor.left, top: anchor.top + anchor.height, maxHeight: spaceBelow }
          : { left: anchor.left, bottom: `calc(100% - ${anchor.top}px)`, maxHeight: spaceAbove }
      }
    >
      <VStack gap={1}>
        <HStack gap={2} vAlign="center">
          <Text type="code" className="min-w-0 flex-1 whitespace-pre-wrap">
            {label.slice(0, start)}
            <Text type="code" weight="bold" color="accent">
              {label.slice(start, end)}
            </Text>
            {label.slice(end)}
          </Text>
          {signature.count > 1 && <Token size="sm" label={`${signature.index}/${signature.count}`} />}
        </HStack>
        {signature.param_doc && <Markdown text={signature.param_doc} />}
        {signature.doc && <Markdown text={signature.doc} />}
      </VStack>
    </Card>
  );
}

/**
 * A translucent card for 'winblend'/'pumblend' (0–100), blurring what's behind it by
 * `backdrop-blur`, like dialogs. Text drawn on it stays opaque.
 */
function blendStyle(blend: number): CSSProperties | undefined {
  if (blend <= 0) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, var(--color-background-card) ${100 - blend}%, transparent)`,
    backdropFilter: 'blur(var(--btm-backdrop-blur, 2px))',
  };
}

/** Space between a float's content and its frame. */
const FRAME_PAD = 6;
/** Height of the title strip, in place of a border's top row. */
const TITLE_HEIGHT = 22;

/**
 * Frames behind Neovim's floating windows (hover, diagnostics, plugin windows). The
 * float's canvas draws on top; its NormalFloat background is transparent so the
 * card shows through, and Neovim's own border is cropped in favor of the card's.
 */
export function NvimFloatFrames({
  floats,
  titles,
  grid,
}: {
  floats: FloatFrame[];
  titles: Record<number, string>;
  grid: NvimGrid;
}) {
  // Floats can touch the edges; keep their frames on screen.
  const bounds = grid.cellRect(grid.rows, grid.cols);
  return floats.map((f) => {
    const title = f.border ? titles[f.grid] : '';
    const left = Math.max(0, f.left - FRAME_PAD);
    const top = Math.max(0, f.top - FRAME_PAD - (title ? TITLE_HEIGHT : 0));
    const right = Math.min(bounds.left, f.left + f.width + FRAME_PAD);
    const bottom = Math.min(bounds.top, f.top + f.height + FRAME_PAD);
    return (
      <Card
        key={f.grid}
        padding={0}
        elevation="med"
        className={`pointer-events-none absolute ${f.focused ? 'border-accent' : ''}`}
        style={{
          left,
          top,
          width: right - left,
          height: bottom - top,
          zIndex: floatFrameZ(f.order),
          ...blendStyle(f.blend),
        }}
      >
        {title && (
          <HStack vAlign="center" className="px-2" style={{ height: TITLE_HEIGHT }}>
            <Text size="sm" weight="semibold" maxLines={1}>
              {title}
            </Text>
          </HStack>
        )}
      </Card>
    );
  });
}

function Markdown({ text }: { text: string }) {
  return (
    <VStack className="prose prose-sm dark:prose-invert max-h-40 max-w-none overflow-y-auto [&_pre]:whitespace-pre-wrap">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </VStack>
  );
}

function CmdlineCard({ cmdline, block, grid }: { cmdline: Cmdline; block: Chunk[][]; grid: NvimGrid }) {
  const label = FIRSTC_LABELS[cmdline.firstc] ?? (cmdline.prompt ? 'Input' : null);
  return (
    <Card padding={2} elevation="high" width="min(100%, 48rem)" className="pointer-events-auto">
      <VStack gap={1}>
        {block.map((line, i) => (
          <Text key={i} type="code" color="secondary" display="block" className="whitespace-pre">
            <Chunks chunks={line} grid={grid} />
          </Text>
        ))}
        <HStack gap={2} vAlign="center">
          {label && <Token size="sm" color={cmdline.firstc === ':' ? 'default' : 'blue'} label={label} />}
          <Text type="code" display="block" className="min-w-0 flex-1 overflow-hidden whitespace-pre">
            {cmdline.prompt}
            {' '.repeat(cmdline.indent)}
            <CmdlineText cmdline={cmdline} grid={grid} />
          </Text>
        </HStack>
      </VStack>
    </Card>
  );
}

/** Content with the cursor (and any pending special char) spliced in at `pos`. */
function CmdlineText({ cmdline, grid }: { cmdline: Cmdline; grid: NvimGrid }) {
  const before: Chunk[] = [];
  const after: Chunk[] = [];
  let offset = 0;
  for (const chunk of cmdline.content) {
    const split = Math.min(Math.max(cmdline.pos - offset, 0), chunk.text.length);
    if (split > 0) before.push({ attr: chunk.attr, text: chunk.text.slice(0, split) });
    if (split < chunk.text.length) after.push({ attr: chunk.attr, text: chunk.text.slice(split) });
    offset += chunk.text.length;
  }
  const special = cmdline.special;
  if (special && !special.shift && after.length) {
    // Overwrite the character under the cursor.
    const [first, ...rest] = after;
    const chars = [...first.text];
    after.splice(0, after.length, ...(chars.length > 1 ? [{ ...first, text: chars.slice(1).join('') }] : []), ...rest);
  }
  return (
    <>
      <Chunks chunks={before} grid={grid} />
      {special ? (
        <Text type="code" color="accent">
          {special.c}
        </Text>
      ) : (
        <Text type="code" className="-mr-0.5 animate-pulse border-l-2 border-accent" aria-hidden>
          {'\u200b'}
        </Text>
      )}
      <Chunks chunks={after} grid={grid} />
    </>
  );
}

function Chunks({ chunks, grid }: { chunks: Chunk[]; grid: NvimGrid }): ReactNode {
  return chunks.map((chunk, i) => {
    const s = grid.attrStyle(chunk.attr);
    if (!s.color && !s.background && !s.bold && !s.italic) return chunk.text;
    return (
      <Text
        key={i}
        type="code"
        weight={s.bold ? 'bold' : undefined}
        // Highlight colors come from the user's Neovim colorscheme.
        style={{ color: s.color, background: s.background, fontStyle: s.italic ? 'italic' : undefined }}
      >
        {chunk.text}
      </Text>
    );
  });
}

/** A completion kind glyph (Nerd Font, via mini.icons) in its highlight color. */
function KindIcon({ icon, color, hidden }: { icon: string; color: string | null; hidden?: boolean }) {
  return (
    // Colors come from the user's colorscheme.
    <Text type="code" aria-hidden className={hidden ? 'invisible' : undefined} style={color ? { color } : undefined}>
      {icon}
    </Text>
  );
}

/** Screen cell the popupmenu is anchored to. */
const menuCell = (menu: Popupmenu, grid: NvimGrid) => grid.screenCell(menu.grid, menu.row, menu.col);

/** Whether the completion menu flips above the cursor because there's more room there. */
function menuAbove(menu: Popupmenu, grid: NvimGrid): boolean {
  const [row] = menuCell(menu, grid);
  const below = grid.rows - row - 1;
  return below < Math.min(menu.items.length, MENU_ROWS) && row > below;
}

/** Insert-mode completion menu, anchored at the completed word. */
function GridPopupmenu({
  menu,
  grid,
  kindIcons,
  onSelect,
  blend,
}: {
  menu: Popupmenu;
  grid: NvimGrid;
  kindIcons: KindIcons;
  onSelect: (i: number) => void;
  blend: number;
}) {
  const anchor = grid.cellRect(...menuCell(menu, grid));
  const placeAbove = menuAbove(menu, grid);
  const info = menu.items[menu.selected]?.info;
  const popupRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = popupRef.current!;
    const surface = popup.offsetParent as HTMLElement | null;
    if (!surface) return;
    const position = () => {
      popup.style.left = `${Math.max(0, Math.min(anchor.left, surface.clientWidth - popup.offsetWidth))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popup);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [anchor.left]);
  return (
    <HStack
      ref={popupRef}
      gap={1}
      vAlign={placeAbove ? 'end' : 'start'}
      width="max-content"
      maxWidth="100%"
      className="absolute z-40"
      onMouseDown={(e) => e.preventDefault()}
      style={
        placeAbove
          ? { left: anchor.left, bottom: `calc(100% - ${anchor.top}px)` }
          : { left: anchor.left, top: anchor.top + anchor.height }
      }
    >
      <Card padding={0.5} elevation="med" maxWidth="60ch" className="min-w-0 overflow-hidden" style={blendStyle(blend)}>
        <MenuList menu={menu} kindIcons={kindIcons} onSelect={onSelect} />
      </Card>
      {info && <InfoCard info={info} blend={blend} />}
    </HStack>
  );
}

/** Documentation for the selected completion item (Markdown, as LSP servers send it). */
function InfoCard({ info, blend }: { info: string; blend: number }) {
  return (
    <Card
      padding={2}
      elevation="med"
      maxWidth="60ch"
      className="prose prose-sm dark:prose-invert max-h-80 min-w-0 overflow-y-auto [&_pre]:whitespace-pre-wrap"
      style={blendStyle(blend)}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{info}</ReactMarkdown>
    </Card>
  );
}

function MenuList({
  menu,
  kindIcons,
  onSelect,
}: {
  menu: Popupmenu;
  kindIcons: KindIcons;
  onSelect: (i: number) => void;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const placeholder = menu.items.map((item) => kindIcons[item.kind]?.icon).find(Boolean);
  useLayoutEffect(() => {
    scrollRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [menu.selected, menu.items]);
  return (
    <VStack ref={scrollRef} className="max-h-80 overflow-y-auto">
      <List density="compact">
        {menu.items.map((item, i) => (
          <ListItem
            key={i}
            label={item.word}
            isSelected={i === menu.selected}
            onClick={() => onSelect(i)}
            startContent={
              kindIcons[item.kind] ? (
                <KindIcon {...kindIcons[item.kind]} />
              ) : (
                // Keep labels aligned with items that have an icon.
                placeholder && <KindIcon icon={placeholder} color={null} hidden />
              )
            }
            endContent={
              (item.kind || item.menu) && (
                <HStack gap={1} vAlign="center">
                  {item.menu && (
                    <Text type="code" size="sm" color="secondary" maxLines={1}>
                      {item.menu}
                    </Text>
                  )}
                  {item.kind && <Token size="sm" label={item.kind} />}
                </HStack>
              )
            }
          />
        ))}
      </List>
    </VStack>
  );
}
