import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent, LayoutFooter, HStack, Section, VStack } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { cn } from '@/lib/utils';
import { useStore } from '@/state/store';
import { KeyCap, KeyHint, type Hint } from '../KeyHint';
import { usePressHint } from '@/hooks/usePressHint';
import type { GitBranchInfo, GitOp, GitRefsResult, GitWorktreeInfo, WorktreeOp } from '@/protocol/file-messages';

export type GitPopupKind = 'branch' | 'fetch' | 'pull' | 'push' | 'stash' | 'worktree';

/** A `WorktreeOp` in the worktree popup, a `GitOp` elsewhere. */
type PopupOp = GitOp | WorktreeOp;

interface GitPopupProps {
  kind: GitPopupKind | null;
  /** The browser's session, preferred when visiting a worktree. */
  sessionId: string;
  /** The browser's pane, whose worktree can't be deleted. */
  paneId: string;
  onClose: () => void;
  /** Close the browser, after visiting a worktree. */
  onLeave: () => void;
  loadRefs: (worktrees: boolean) => Promise<GitRefsResult>;
  run: (op: GitOp) => Promise<string>;
  runWorktree: (op: WorktreeOp) => Promise<string>;
}

interface Switch {
  key: string;
  flag: string;
  label: string;
}

interface PromptOption {
  value: string;
  label: string;
  description?: string;
}

interface Prompt {
  title: string;
  label: string;
  initial?: string;
  options?: PromptOption[];
  allowCustom?: boolean;
  allowEmpty?: boolean;
  submit: (value: string) => PopupOp;
}

interface Action {
  key: string;
  label: string;
  description?: string;
  isDisabled?: boolean;
  /** An op to run immediately, a prompt that produces one, or a local action. */
  next: () => PopupOp | Prompt | Confirmation | (() => void);
}

interface Confirmation {
  confirm: PopupOp;
  title: string;
  description: string;
  label: string;
}

const TITLES: Record<GitPopupKind, string> = {
  branch: 'Branch',
  fetch: 'Fetch',
  pull: 'Pull',
  push: 'Push',
  stash: 'Stash',
  worktree: 'Worktree',
};

const SWITCHES: Record<GitPopupKind, Switch[]> = {
  branch: [],
  fetch: [
    { key: 'p', flag: '--prune', label: 'Prune deleted branches' },
    { key: 't', flag: '--tags', label: 'Fetch all tags' },
  ],
  pull: [
    { key: 'r', flag: '--rebase', label: 'Rebase local commits' },
    { key: 'f', flag: '--ff-only', label: 'Fast-forward only' },
  ],
  push: [
    { key: 'f', flag: '--force-with-lease', label: 'Force with lease' },
    { key: 'h', flag: '--no-verify', label: 'Disable hooks' },
    { key: 'n', flag: '--dry-run', label: 'Dry run' },
  ],
  stash: [
    { key: 'u', flag: '--include-untracked', label: 'Also save untracked files' },
    { key: 'a', flag: '--all', label: 'Also save untracked and ignored files' },
  ],
  worktree: [],
};

/** Popups that list refs to act on. */
function isListKind(kind: GitPopupKind): kind is 'branch' | 'worktree' {
  return kind === 'branch' || kind === 'worktree';
}

function remoteOptions(refs: GitRefsResult): PromptOption[] {
  return refs.remotes.map((remote) => ({ value: remote, label: remote }));
}

function upstreamRemote(refs: GitRefsResult): string | undefined {
  return refs.remotes.find((remote) => refs.upstream?.startsWith(`${remote}/`));
}

/** Splits `origin/feature/x` into its remote and branch using the known remotes. */
function splitRemoteBranch(refs: GitRefsResult, value: string): { remote: string; branch: string } {
  const remote = [...refs.remotes].sort((a, b) => b.length - a.length).find((name) => value.startsWith(`${name}/`));
  if (remote) return { remote, branch: value.slice(remote.length + 1) };
  const slash = value.indexOf('/');
  return slash > 0 ? { remote: value.slice(0, slash), branch: value.slice(slash + 1) } : { remote: value, branch: '' };
}

function stashOptions(refs: GitRefsResult): PromptOption[] {
  return refs.stashes.map((stash) => ({
    value: String(stash.index),
    label: `stash@{${stash.index}}`,
    description: stash.message,
  }));
}

interface ListContext {
  selected?: GitBranchInfo;
  remoteView: boolean;
  worktree?: GitWorktreeInfo;
  /** Pane IDs in each worktree, by path, the browser's session first. */
  worktreePanes: Map<string, string[]>;
  /** The worktree of the browser's pane. */
  hostWorktree?: string;
  visitPane: (paneId: string) => void;
}

function worktreeName(worktree: GitWorktreeInfo): string {
  return worktree.branch ?? (worktree.bare ? '(bare)' : `(detached ${worktree.head.slice(0, 7)})`);
}

function paneCount(count: number): string {
  return count === 1 ? '1 pane' : `${count} panes`;
}

/** Branches a new worktree can check out or track, then remote ones. */
function worktreeBranchOptions(refs: GitRefsResult): PromptOption[] {
  const checkedOut = new Set(refs.worktrees.map((worktree) => worktree.branch));
  return [...refs.local_branches.filter((branch) => !checkedOut.has(branch.name)), ...refs.remote_branches].map(
    (branch) => ({ value: branch.name, label: branch.name, description: branch.subject }),
  );
}

function buildActions(
  kind: GitPopupKind,
  refs: GitRefsResult,
  flags: Set<string>,
  { selected, remoteView, worktree, worktreePanes, hostWorktree, visitPane }: ListContext,
): Action[] {
  const on = (flag: string) => flags.has(flag);
  const branch = refs.branch;
  const detached = branch === null;
  const noRemotes = refs.remotes.length === 0;

  switch (kind) {
    case 'branch':
      return [
        {
          key: 'Enter',
          label: 'Checkout',
          isDisabled: !selected || selected.is_head,
          next: () => ({ kind: 'checkout', target: selected!.name }),
        },
        {
          key: 'c',
          label: 'Create and checkout',
          next: () => ({
            title: 'Create and checkout branch',
            label: 'Branch name',
            allowCustom: true,
            submit: (name) => ({ kind: 'create_branch', name, checkout: true }),
          }),
        },
        {
          key: 'b',
          label: 'Checkout revision',
          next: () => ({
            title: 'Checkout branch or revision',
            label: 'Branch or revision',
            allowCustom: true,
            submit: (target) => ({ kind: 'checkout', target }),
          }),
        },
        {
          key: 'n',
          label: 'Create',
          next: () => ({
            title: 'Create branch',
            label: 'Branch name',
            allowCustom: true,
            submit: (name) => ({ kind: 'create_branch', name, checkout: false }),
          }),
        },
        {
          key: 'm',
          label: 'Rename',
          isDisabled: remoteView || !selected,
          next: () => ({
            title: `Rename ${selected!.name}`,
            label: 'New name',
            initial: selected!.name,
            allowCustom: true,
            submit: (to) => ({ kind: 'rename_branch', from: selected!.name, to }),
          }),
        },
        {
          key: 'd',
          label: 'Delete',
          isDisabled: remoteView || !selected || selected.is_head,
          next: () => ({ kind: 'delete_branch', name: selected!.name }),
        },
        {
          key: 'D',
          label: 'Force delete',
          isDisabled: remoteView || !selected || selected.is_head,
          next: () => ({
            title: `Force delete ${selected!.name}?`,
            description: 'This deletes the local branch even if its commits have not been merged.',
            label: 'Force delete',
            confirm: { kind: 'delete_branch', name: selected!.name, force: true },
          }),
        },
      ];
    case 'worktree': {
      const panes = worktree ? (worktreePanes.get(worktree.path) ?? []) : [];
      // git refuses a locked one even with --force.
      const removable =
        !!worktree &&
        !worktree.main &&
        !worktree.current &&
        !worktree.prunable &&
        worktree.locked === null &&
        worktree.path !== hostWorktree;
      const closes = panes.length ? ` and closes its ${paneCount(panes.length)}` : '';
      const createPrompt = (visit: boolean): Prompt => ({
        title: visit ? 'Create and visit worktree' : 'Create worktree',
        label: 'Branch (existing or new)',
        options: worktreeBranchOptions(refs),
        allowCustom: true,
        // A remote branch is checked out as a local branch tracking it.
        submit: (value) =>
          refs.remote_branches.some((branch) => branch.name === value)
            ? { kind: 'add', branch: splitRemoteBranch(refs, value).branch, track: value, visit }
            : { kind: 'add', branch: value, visit },
      });
      return [
        {
          key: 'Enter',
          label: 'Visit',
          isDisabled: !worktree || worktree.bare || worktree.prunable,
          next: () => (panes.length ? () => visitPane(panes[0]) : { kind: 'open', path: worktree!.path }),
        },
        { key: 'c', label: 'Create and visit', next: () => createPrompt(true) },
        { key: 'n', label: 'Create', next: () => createPrompt(false) },
        {
          key: 'd',
          label: 'Delete',
          isDisabled: !removable,
          // Removal also deletes ignored files.
          next: () => ({
            title: `Delete worktree ${worktreeName(worktree!)}?`,
            description: `This removes ${worktree!.path} with its ignored files${closes}. The branch is kept.`,
            label: 'Delete',
            confirm: { kind: 'remove', path: worktree!.path },
          }),
        },
        {
          key: 'D',
          label: 'Force delete',
          isDisabled: !removable,
          next: () => ({
            title: `Force delete worktree ${worktreeName(worktree!)}?`,
            description: `This removes ${worktree!.path} with its ignored files, even if it has uncommitted changes${closes}. The branch is kept.`,
            label: 'Force delete',
            confirm: { kind: 'remove', path: worktree!.path, force: true },
          }),
        },
        {
          key: 'l',
          label: worktree && worktree.locked !== null ? 'Unlock' : 'Lock',
          isDisabled: !worktree || worktree.main,
          next: () => ({ kind: worktree!.locked !== null ? 'unlock' : 'lock', path: worktree!.path }),
        },
        {
          key: 'p',
          label: 'Prune',
          isDisabled: !refs.worktrees.some((worktree) => worktree.prunable),
          next: () => ({ kind: 'prune' }),
        },
      ];
    }
    case 'fetch': {
      const base = { prune: on('--prune'), tags: on('--tags') };
      return [
        {
          key: 'u',
          label: 'From upstream',
          description: upstreamRemote(refs) ?? 'default remote',
          isDisabled: noRemotes,
          next: () => ({ kind: 'fetch', ...base }),
        },
        {
          key: 'e',
          label: 'From elsewhere',
          isDisabled: noRemotes,
          next: () => ({
            title: 'Fetch from',
            label: 'Remote',
            options: remoteOptions(refs),
            submit: (remote) => ({ kind: 'fetch', remote, ...base }),
          }),
        },
        {
          key: 'a',
          label: 'From all remotes',
          isDisabled: noRemotes,
          next: () => ({ kind: 'fetch', all: true, ...base }),
        },
      ];
    }
    case 'pull': {
      const base = { rebase: on('--rebase'), ff_only: on('--ff-only') };
      return [
        {
          key: 'u',
          label: 'From upstream',
          description: refs.upstream ?? 'no upstream',
          isDisabled: detached || !refs.upstream,
          next: () => ({ kind: 'pull', ...base }),
        },
        {
          key: 'e',
          label: 'From elsewhere',
          isDisabled: detached || refs.remote_branches.length === 0,
          next: () => ({
            title: 'Pull from',
            label: 'Remote branch',
            options: refs.remote_branches.map(({ name }) => ({ value: name, label: name })),
            submit: (value) => ({ kind: 'pull', ...splitRemoteBranch(refs, value), ...base }),
          }),
        },
      ];
    }
    case 'push': {
      const base = {
        force_with_lease: on('--force-with-lease'),
        no_verify: on('--no-verify'),
        dry_run: on('--dry-run'),
      };
      return [
        {
          key: 'u',
          label: refs.upstream ? 'To upstream' : 'To upstream (set)',
          description: refs.upstream ?? undefined,
          isDisabled: detached || noRemotes,
          next: () =>
            refs.upstream
              ? { kind: 'push', ...base }
              : {
                  title: `Set upstream for ${branch} and push`,
                  label: 'Remote',
                  options: remoteOptions(refs),
                  submit: (remote) => ({ kind: 'push', remote, refspec: branch!, set_upstream: true, ...base }),
                },
        },
        {
          key: 'e',
          label: 'To elsewhere',
          isDisabled: detached || noRemotes,
          next: () => ({
            title: `Push ${branch} to`,
            label: 'Remote',
            options: remoteOptions(refs),
            submit: (remote) => ({ kind: 'push', remote, refspec: branch!, ...base }),
          }),
        },
        {
          key: 't',
          label: 'Tags',
          isDisabled: noRemotes,
          next: () => ({
            title: 'Push tags to',
            label: 'Remote',
            initial: upstreamRemote(refs),
            options: remoteOptions(refs),
            submit: (remote) => ({ kind: 'push', remote, tags: true, ...base }),
          }),
        },
      ];
    }
    case 'stash': {
      const base = { include_untracked: on('--include-untracked'), all: on('--all') };
      const noStashes = refs.stashes.length === 0;
      const pick = (title: string, submit: (index: number) => GitOp): Prompt => ({
        title,
        label: 'Stash',
        options: stashOptions(refs),
        submit: (value) => submit(Number(value)),
      });
      return [
        {
          key: 'z',
          label: 'Both',
          next: () => ({
            title: 'Stash index and worktree',
            label: 'Message (optional)',
            allowCustom: true,
            allowEmpty: true,
            submit: (message) => ({ kind: 'stash_push', message, ...base }),
          }),
        },
        {
          key: 'i',
          label: 'Index',
          next: () => ({
            title: 'Stash index',
            label: 'Message (optional)',
            allowCustom: true,
            allowEmpty: true,
            submit: (message) => ({ kind: 'stash_push', message, staged: true, ...base }),
          }),
        },
        {
          key: 'a',
          label: 'Apply',
          isDisabled: noStashes,
          next: () => pick('Apply stash', (index) => ({ kind: 'stash_apply', index, pop: false })),
        },
        {
          key: 'p',
          label: 'Pop',
          isDisabled: noStashes,
          next: () => pick('Pop stash', (index) => ({ kind: 'stash_apply', index, pop: true })),
        },
        {
          key: 'k',
          label: 'Drop',
          isDisabled: noStashes,
          next: () => pick('Drop stash', (index) => ({ kind: 'stash_drop', index })),
        },
      ];
    }
  }
}

function describeOp(op: PopupOp): string {
  switch (op.kind) {
    case 'add':
      return `Creating a worktree for ${op.branch}`;
    case 'open':
      return `Opening ${op.path}`;
    case 'remove':
      return `Removing ${op.path}`;
    case 'lock':
      return `Locking ${op.path}`;
    case 'unlock':
      return `Unlocking ${op.path}`;
    case 'prune':
      return 'Pruning worktrees';
    case 'checkout':
      return `Checking out ${op.target}`;
    case 'create_branch':
      return `Creating ${op.name}`;
    case 'rename_branch':
      return `Renaming ${op.from} to ${op.to}`;
    case 'delete_branch':
      return `Deleting ${op.name}`;
    case 'fetch':
      return op.all ? 'Fetching all remotes' : `Fetching ${op.remote ?? 'upstream'}`;
    case 'pull':
      return op.remote ? `Pulling ${op.remote}/${op.branch}` : 'Pulling upstream';
    case 'push':
      return op.tags ? `Pushing tags to ${op.remote}` : `Pushing to ${op.remote ?? 'upstream'}`;
    case 'stash_push':
      return 'Stashing';
    case 'stash_apply':
      return `${op.pop ? 'Popping' : 'Applying'} stash@{${op.index}}`;
    case 'stash_drop':
      return `Dropping stash@{${op.index}}`;
    case 'stage_all':
      return 'Staging all changes';
    case 'unstage_all':
      return 'Unstaging all changes';
  }
}

function filterOptions(options: PromptOption[], query: string): PromptOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => o.label.toLowerCase().includes(q) || o.description?.toLowerCase().includes(q));
}

function branchDescription(branch: GitBranchInfo): string {
  const tracking = [
    ...(branch.upstream_gone ? ['gone'] : []),
    ...(branch.ahead ? [`ahead ${branch.ahead}`] : []),
    ...(branch.behind ? [`behind ${branch.behind}`] : []),
  ];
  const upstream = branch.upstream ? `[${branch.upstream}${tracking.length ? `: ${tracking.join(', ')}` : ''}] ` : '';
  return `${branch.commit.slice(0, 7)} ${upstream}${branch.subject}`;
}

function worktreeFlags(worktree: GitWorktreeInfo, panes: number): string {
  return [
    ...(worktree.current ? ['current'] : []),
    ...(worktree.main ? ['main'] : []),
    ...(worktree.locked !== null ? [worktree.locked ? `locked: ${worktree.locked}` : 'locked'] : []),
    ...(worktree.prunable ? ['prunable'] : []),
    ...(panes ? [paneCount(panes)] : []),
  ].join(' · ');
}

/** Whether the popup stays open after `op` succeeds, to show the updated list. */
function staysOpen(kind: GitPopupKind, op: PopupOp): boolean {
  if (kind === 'branch') return op.kind !== 'checkout' && !(op.kind === 'create_branch' && op.checkout);
  if (kind === 'worktree') return op.kind !== 'open' && !(op.kind === 'add' && op.visit);
  return false;
}

// Switches persist per popup for the page lifetime, like transient.
const savedFlags: Partial<Record<GitPopupKind, Set<string>>> = {};

export function GitPopup({ kind, ...props }: GitPopupProps) {
  // Remount per open so each popup starts from fresh state.
  return kind ? <GitPopupDialog key={kind} kind={kind} {...props} /> : null;
}

function GitPopupDialog({
  kind,
  sessionId,
  paneId,
  onClose,
  onLeave,
  loadRefs,
  run,
  runWorktree,
}: GitPopupProps & { kind: GitPopupKind }) {
  const [refs, setRefs] = useState<GitRefsResult | null>(null);
  const [flags, setFlags] = useState<Set<string>>(() => new Set(savedFlags[kind] ?? []));
  const [dashPending, setDashPending] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [remoteView, setRemoteView] = useState(false);
  const [branchIndex, setBranchIndex] = useState(0);
  const [worktreeIndex, setWorktreeIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [optionIndex, setOptionIndex] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An action key pressed before refs finish loading.
  const [queuedKey, setQueuedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressHint = usePressHint(dialogRef);

  useEffect(() => {
    let cancelled = false;
    loadRefs(kind === 'worktree').then(
      (result) => {
        if (cancelled) return;
        setRefs(result);
        setBranchIndex(
          Math.max(
            0,
            result.local_branches.findIndex((branch) => branch.is_head),
          ),
        );
        setWorktreeIndex(
          Math.max(
            0,
            result.worktrees.findIndex((worktree) => worktree.current),
          ),
        );
      },
      (err) => !cancelled && setError(err instanceof Error ? err.message : 'Failed to read refs'),
    );
    return () => {
      cancelled = true;
    };
  }, [loadRefs, kind]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (prompt) inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [prompt]);

  useLayoutEffect(() => {
    if (isListKind(kind) && !prompt) contentRef.current?.focus();
  }, [kind, prompt, confirmation, running]);

  useEffect(() => {
    contentRef.current
      ?.querySelector('[aria-selected="true"], [aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [optionIndex, branchIndex, worktreeIndex, remoteView, refs, prompt, running]);

  const allSessions = useStore((s) => s.allSessions);
  const { worktreePanes, hostWorktree } = useMemo(() => {
    const panes = new Map<string, string[]>();
    let host: string | undefined;
    const ordered = [...allSessions].sort((a, b) => Number(b.id === sessionId) - Number(a.id === sessionId));
    for (const session of ordered) {
      for (const pane of session.windows.flatMap((window) => window.panes)) {
        const root = pane.git?.worktree_root;
        if (root) panes.set(root, [...(panes.get(root) ?? []), pane.id]);
        if (pane.id === paneId) host = root;
      }
    }
    return { worktreePanes: panes, hostWorktree: host };
  }, [allSessions, sessionId, paneId]);
  const visitPane = (id: string) => {
    useStore.getState().navigateToPane(id);
    onLeave();
  };

  const switches = SWITCHES[kind];
  const branches = (remoteView ? refs?.remote_branches : refs?.local_branches) ?? [];
  const selected = branches[Math.min(branchIndex, Math.max(0, branches.length - 1))];
  const worktrees = refs?.worktrees ?? [];
  const worktree = worktrees[Math.min(worktreeIndex, Math.max(0, worktrees.length - 1))];
  const listLength = kind === 'worktree' ? worktrees.length : branches.length;
  const listIndex = kind === 'worktree' ? worktreeIndex : branchIndex;
  const setListIndex = kind === 'worktree' ? setWorktreeIndex : setBranchIndex;
  const actions = refs
    ? buildActions(kind, refs, flags, { selected, remoteView, worktree, worktreePanes, hostWorktree, visitPane })
    : [];
  const options = prompt?.options ? filterOptions(prompt.options, query) : [];

  const close = () => {
    if (running) return;
    if (isListKind(kind) && (prompt || confirmation)) {
      setPrompt(null);
      setConfirmation(null);
      setError(null);
    } else onClose();
  };

  const hints: Hint[] = running
    ? []
    : confirmation
      ? [{ keys: ['esc'], label: 'cancel' }]
      : prompt
        ? [
            ...(options.length
              ? [
                  { keys: ['up', 'down'], label: 'select' },
                  { keys: ['tab'], label: 'complete' },
                ]
              : []),
            { keys: ['enter'], label: 'run' },
            { keys: ['esc'], label: isListKind(kind) ? 'back' : 'close' },
          ]
        : [{ keys: ['esc', 'q'], label: 'close' }];

  const execute = async (op: PopupOp) => {
    setPrompt(null);
    setConfirmation(null);
    setError(null);
    setRunning(describeOp(op));
    try {
      const output = kind === 'worktree' ? await runWorktree(op as WorktreeOp) : await run(op as GitOp);
      if (staysOpen(kind, op)) {
        const nextRefs = await loadRefs(kind === 'worktree');
        setRefs(nextRefs);
        if (kind === 'worktree') {
          const nextIndex = nextRefs.worktrees.findIndex((next) =>
            op.kind === 'add' ? next.branch === op.branch : next.path === worktree?.path,
          );
          const last = nextRefs.worktrees.length - 1;
          setWorktreeIndex(nextIndex >= 0 ? nextIndex : Math.max(0, Math.min(worktreeIndex, last)));
        } else {
          const nextBranches = remoteView ? nextRefs.remote_branches : nextRefs.local_branches;
          const nextName = op.kind === 'rename_branch' ? op.to : selected?.name;
          const nextIndex = nextBranches.findIndex((branch) => branch.name === nextName);
          setBranchIndex(nextIndex >= 0 ? nextIndex : Math.max(0, Math.min(branchIndex, nextBranches.length - 1)));
        }
        setRunning(null);
      } else if (kind === 'worktree') {
        // It visited the worktree.
        onLeave();
      } else onClose();
      // git ends with its summary line (e.g. `main -> main`, `Already up to date.`).
      const summary = output.trim().split('\n').pop()?.trim();
      if (summary) {
        useStore.getState().showToast(`git ${TITLES[kind].toLowerCase()}`, 'success', { body: summary });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'git failed');
      setRunning(null);
    }
  };

  const choose = (action: Action) => {
    if (action.isDisabled || running) return;
    const next = action.next();
    if (typeof next === 'function') {
      next();
    } else if ('confirm' in next) {
      setError(null);
      setConfirmation(next);
    } else if ('kind' in next) {
      void execute(next);
    } else {
      setError(null);
      setQuery(next.initial ?? '');
      setOptionIndex(0);
      setPrompt(next);
    }
  };

  const toggle = (flag: string) => {
    const next = new Set(flags);
    if (next.has(flag)) {
      next.delete(flag);
    } else {
      next.add(flag);
      // --all supersedes --include-untracked.
      if (flag === '--all') next.delete('--include-untracked');
      if (flag === '--include-untracked') next.delete('--all');
    }
    savedFlags[kind] = next;
    setFlags(next);
  };

  const submitPrompt = () => {
    if (!prompt) return;
    const option = options[optionIndex];
    const typed = query.trim();
    // Prefer the highlighted option unless the exact typed value is custom.
    const value =
      option && !(prompt.allowCustom && typed && !prompt.options?.some((o) => o.value === typed))
        ? option.value
        : prompt.allowCustom
          ? typed
          : null;
    if (value === null || (!value && !prompt.allowEmpty)) return;
    void execute(prompt.submit(value));
  };

  useEffect(() => {
    if (!refs || !queuedKey) return;
    setQueuedKey(null);
    const action = actions.find((a) => a.key === queuedKey);
    if (action) choose(action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, queuedKey]);

  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (running || event.nativeEvent.isComposing) return;

    if (confirmation) {
      if (event.key === 'y' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        void execute(confirmation.confirm);
      } else if (event.key === 'n' || event.key === 'q') {
        event.preventDefault();
        close();
      }
      return;
    }

    if (prompt) {
      const count = options.length;
      const direction =
        event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')
          ? 1
          : event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')
            ? -1
            : 0;
      if (direction && count) {
        event.preventDefault();
        setOptionIndex((optionIndex + direction + count) % count);
      } else if (event.key === 'Tab' && options[optionIndex]) {
        event.preventDefault();
        setQuery(options[optionIndex].value);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        submitPrompt();
      }
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isListKind(kind)) {
      const direction =
        event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0;
      if (direction) {
        event.preventDefault();
        if (listLength) setListIndex((listIndex + direction + listLength) % listLength);
        return;
      }
      if (kind === 'branch' && event.key === 'r') {
        event.preventDefault();
        toggleBranchView();
        return;
      }
      if (event.key === 'Enter') {
        // Buttons retain their native Enter behavior.
        if ((event.target as HTMLElement).closest('button') && !contentRef.current?.contains(event.target as Node))
          return;
        event.preventDefault();
        const action = actions.find((action) => action.key === 'Enter');
        if (action) choose(action);
        return;
      }
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    if (dashPending) {
      setDashPending(false);
      const sw = switches.find((s) => s.key === event.key);
      if (sw) toggle(sw.flag);
      return;
    }
    if (event.key === '-' && switches.length) {
      setDashPending(true);
      return;
    }
    if (event.key === 'q') {
      close();
      return;
    }
    if (!refs) {
      setQueuedKey((queued) => queued ?? event.key);
      return;
    }
    const action = actions.find((a) => a.key === event.key);
    if (action) choose(action);
  };

  const toggleBranchView = () => {
    setRemoteView(!remoteView);
    setBranchIndex(remoteView ? Math.max(0, refs?.local_branches.findIndex((branch) => branch.is_head) ?? 0) : 0);
    setError(null);
  };

  return (
    <Dialog
      ref={dialogRef}
      isOpen
      onOpenChange={(open) => !open && close()}
      width={isListKind(kind) ? 760 : 520}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <Layout
        header={
          <DialogHeader
            title={
              confirmation?.title ??
              prompt?.title ??
              (kind === 'branch'
                ? `${remoteView ? 'Remote' : 'Local'} branches`
                : kind === 'worktree'
                  ? 'Worktrees'
                  : TITLES[kind])
            }
            subtitle={refs ? (refs.branch ?? 'detached HEAD') : undefined}
            hasDivider
            onOpenChange={(open) => !open && close()}
          />
        }
        content={
          <LayoutContent
            ref={contentRef}
            padding={4}
            tabIndex={isListKind(kind) ? -1 : undefined}
            className={isListKind(kind) ? 'outline-none' : undefined}
          >
            <VStack gap={3}>
              {error && <Banner status="error" title={error} />}
              {running ? (
                <Spinner label={`${running}…`} />
              ) : confirmation ? (
                <Text>{confirmation.description}</Text>
              ) : prompt ? (
                <VStack gap={2}>
                  <TextInput
                    ref={inputRef}
                    label={prompt.label}
                    value={query}
                    onChange={(value) => {
                      setQuery(value);
                      setOptionIndex(0);
                    }}
                    hasAutoFocus
                  />
                  {prompt.options && (
                    <List density="compact">
                      {options.map((option, index) => (
                        <ListItem
                          key={option.value}
                          label={option.label}
                          description={option.description}
                          isSelected={index === optionIndex}
                          onClick={() => void execute(prompt.submit(option.value))}
                        />
                      ))}
                    </List>
                  )}
                  {prompt.options && !options.length && (
                    <Text color="secondary">
                      {prompt.allowCustom && query.trim() ? `Enter to use “${query.trim()}”` : 'No matches'}
                    </Text>
                  )}
                </VStack>
              ) : !refs ? (
                !error && <Spinner label="Reading refs…" />
              ) : kind === 'worktree' ? (
                <List density="compact" className="btm-mono" aria-label="Worktrees">
                  {worktrees.map((item, index) => (
                    <ListItem
                      key={item.path}
                      label={worktreeName(item)}
                      description={
                        <>
                          {item.path}
                          <br />
                          {item.head ? `${item.head.slice(0, 7)} ${item.subject}` : ''}
                        </>
                      }
                      startContent={
                        <Text type="code" color={item.current ? 'accent' : 'secondary'}>
                          {item.current ? '*' : '·'}
                        </Text>
                      }
                      endContent={
                        <Text size="sm" color="secondary">
                          {worktreeFlags(item, worktreePanes.get(item.path)?.length ?? 0)}
                        </Text>
                      }
                      isSelected={item.path === worktree?.path}
                      onClick={() => setWorktreeIndex(index)}
                    />
                  ))}
                </List>
              ) : kind === 'branch' && !branches.length ? (
                <Text color="secondary">No {remoteView ? 'remote' : 'local'} branches</Text>
              ) : kind === 'branch' ? (
                <List
                  density="compact"
                  className="btm-mono"
                  aria-label={remoteView ? 'Remote branches' : 'Local branches'}
                >
                  {branches.map((branch) => (
                    <ListItem
                      key={branch.name}
                      label={branch.name}
                      description={branchDescription(branch)}
                      startContent={
                        <Text type="code" color={branch.is_head ? 'accent' : 'secondary'}>
                          {branch.is_head ? '*' : '·'}
                        </Text>
                      }
                      endContent={
                        branch.is_head ? (
                          <Text size="sm" color="secondary">
                            current
                          </Text>
                        ) : undefined
                      }
                      isSelected={branch.name === selected?.name}
                      onClick={() => setBranchIndex(branches.indexOf(branch))}
                    />
                  ))}
                </List>
              ) : (
                <VStack gap={2}>
                  {switches.length > 0 && (
                    <Section variant="transparent">
                      <Heading level={3}>Arguments</Heading>
                      <List density="compact">
                        {switches.map((sw) => {
                          const active = flags.has(sw.flag);
                          return (
                            <ListItem
                              key={sw.flag}
                              label={sw.label}
                              startContent={
                                <HStack gap={1}>
                                  <KeyCap keys="-" />
                                  <KeyCap keys={sw.key} />
                                </HStack>
                              }
                              endContent={
                                <Text
                                  type="code"
                                  size="sm"
                                  color={active ? 'inherit' : 'disabled'}
                                  className={cn(active && 'text-cyan-vivid')}
                                >
                                  {sw.flag}
                                </Text>
                              }
                              onClick={() => toggle(sw.flag)}
                            />
                          );
                        })}
                      </List>
                    </Section>
                  )}
                  <Section variant="transparent">
                    <Heading level={3}>Actions</Heading>
                    <List density="compact">
                      {actions.map((action) => (
                        <ListItem
                          key={action.key}
                          label={action.label}
                          startContent={<KeyCap keys={action.key} />}
                          endContent={
                            action.description ? (
                              <Text size="sm" color="secondary">
                                {action.description}
                              </Text>
                            ) : undefined
                          }
                          isDisabled={action.isDisabled}
                          onClick={() => choose(action)}
                        />
                      ))}
                    </List>
                  </Section>
                  {dashPending && <Text color="secondary">- (press a switch key)</Text>}
                </VStack>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          !running && confirmation ? (
            <LayoutFooter hasDivider>
              <HStack gap={3} hAlign="end">
                <Button label="Cancel" onClick={close}>
                  <KeyHint keys={['esc']} label="cancel" />
                </Button>
                <Button
                  label={confirmation.label}
                  variant="destructive"
                  onClick={() => void execute(confirmation.confirm)}
                >
                  <KeyHint keys={['y']} label={confirmation.label} />
                </Button>
              </HStack>
            </LayoutFooter>
          ) : !running && !prompt && isListKind(kind) ? (
            <LayoutFooter hasDivider>
              <HStack gap={4} vAlign="center" wrap="wrap" className="gap-y-1">
                {actions.map((action) => (
                  <HStack key={action.key} className={cn('flex-none', action.isDisabled && 'opacity-50')}>
                    <KeyHint
                      keys={[action.key === 'Enter' ? 'enter' : action.key]}
                      label={action.label.toLowerCase()}
                      onPress={pressHint}
                    />
                  </HStack>
                ))}
                {kind === 'branch' && (
                  <KeyHint keys={['r']} label={remoteView ? 'local' : 'remote'} onPress={pressHint} />
                )}
                <KeyHint keys={['j', 'k', 'down', 'up']} label="select" onPress={pressHint} />
                <KeyHint keys={['esc', 'q']} label="close" onPress={pressHint} />
              </HStack>
            </LayoutFooter>
          ) : hints.length > 0 ? (
            <LayoutFooter hasDivider>
              <HStack gap={4} wrap="wrap">
                {hints.map((hint) => (
                  <KeyHint key={hint.keys.join()} keys={hint.keys} label={hint.label} onPress={pressHint} />
                ))}
              </HStack>
            </LayoutFooter>
          ) : undefined
        }
      />
    </Dialog>
  );
}
