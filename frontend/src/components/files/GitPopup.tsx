import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
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
import type { GitOp, GitRefsResult } from '@/protocol/file-messages';

export type GitPopupKind = 'branch' | 'fetch' | 'pull' | 'push' | 'stash';

interface GitPopupProps {
  kind: GitPopupKind | null;
  onClose: () => void;
  loadRefs: () => Promise<GitRefsResult>;
  run: (op: GitOp) => Promise<string>;
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
  submit: (value: string) => GitOp;
}

interface Action {
  key: string;
  label: string;
  description?: string;
  isDisabled?: boolean;
  /** An op to run immediately, or a prompt that produces one. */
  next: () => GitOp | Prompt;
}

const TITLES: Record<GitPopupKind, string> = {
  branch: 'Branch',
  fetch: 'Fetch',
  pull: 'Pull',
  push: 'Push',
  stash: 'Stash',
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
};

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

function buildActions(kind: GitPopupKind, refs: GitRefsResult, flags: Set<string>): Action[] {
  const on = (flag: string) => flags.has(flag);
  const branch = refs.branch;
  const detached = branch === null;
  const otherLocal = refs.local_branches.filter((b) => !b.is_head);
  const noRemotes = refs.remotes.length === 0;

  switch (kind) {
    case 'branch':
      return [
        {
          key: 'b',
          label: 'Checkout',
          next: () => ({
            title: 'Checkout',
            label: 'Branch or revision',
            options: [
              ...otherLocal.map((b) => ({ value: b.name, label: b.name, description: b.upstream ?? undefined })),
              ...refs.remote_branches.map((name) => ({ value: name, label: name })),
            ],
            allowCustom: true,
            submit: (target) => ({ kind: 'checkout', target }),
          }),
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
          description: branch ?? undefined,
          isDisabled: detached,
          next: () => ({
            title: `Rename ${branch}`,
            label: 'New name',
            initial: branch ?? '',
            allowCustom: true,
            submit: (to) => ({ kind: 'rename_branch', from: branch!, to }),
          }),
        },
        {
          key: 'x',
          label: 'Delete',
          isDisabled: otherLocal.length === 0,
          next: () => ({
            title: 'Delete branch',
            label: 'Branch',
            options: otherLocal.map((b) => ({ value: b.name, label: b.name })),
            submit: (name) => ({ kind: 'delete_branch', name }),
          }),
        },
      ];
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
            options: refs.remote_branches.map((name) => ({ value: name, label: name })),
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

function describeOp(op: GitOp): string {
  switch (op.kind) {
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

// Switches persist per popup for the page lifetime, like transient.
const savedFlags: Partial<Record<GitPopupKind, Set<string>>> = {};

export function GitPopup({ kind, ...props }: GitPopupProps) {
  // Remount per open so each popup starts from fresh state.
  return kind ? <GitPopupDialog key={kind} kind={kind} {...props} /> : null;
}

function GitPopupDialog({ kind, onClose, loadRefs, run }: GitPopupProps & { kind: GitPopupKind }) {
  const [refs, setRefs] = useState<GitRefsResult | null>(null);
  const [flags, setFlags] = useState<Set<string>>(() => new Set(savedFlags[kind] ?? []));
  const [dashPending, setDashPending] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [query, setQuery] = useState('');
  const [optionIndex, setOptionIndex] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An action key pressed before refs finish loading.
  const [queuedKey, setQueuedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadRefs().then(
      (result) => !cancelled && setRefs(result),
      (err) => !cancelled && setError(err instanceof Error ? err.message : 'Failed to read refs'),
    );
    return () => {
      cancelled = true;
    };
  }, [loadRefs]);

  useEffect(() => {
    if (prompt) window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [prompt]);

  useEffect(() => {
    contentRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [optionIndex]);

  const switches = SWITCHES[kind];
  const actions = refs ? buildActions(kind, refs, flags) : [];
  const options = prompt?.options ? filterOptions(prompt.options, query) : [];

  const close = () => {
    if (!running) onClose();
  };

  const hints: Hint[] = running
    ? []
    : prompt
      ? [
          ...(options.length
            ? [
                { keys: ['up', 'down'], label: 'select' },
                { keys: ['tab'], label: 'complete' },
              ]
            : []),
          { keys: ['enter'], label: 'run' },
          { keys: ['esc'], label: 'close' },
        ]
      : [{ keys: ['esc', 'q'], label: 'close' }];

  const execute = async (op: GitOp) => {
    setPrompt(null);
    setError(null);
    setRunning(describeOp(op));
    try {
      const output = await run(op);
      onClose();
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
    if ('kind' in next) {
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

    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
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

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => !open && close()}
      width={520}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <Layout
        header={
          <DialogHeader
            title={prompt?.title ?? TITLES[kind]}
            subtitle={refs ? (refs.branch ?? 'detached HEAD') : undefined}
            hasDivider
            onOpenChange={(open) => !open && close()}
          />
        }
        content={
          <LayoutContent ref={contentRef} padding={4}>
            <VStack gap={3}>
              {error && <Banner status="error" title={error} />}
              {running ? (
                <Spinner label={`${running}…`} />
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
          hints.length > 0 ? (
            <LayoutFooter hasDivider>
              <HStack gap={4} wrap="wrap">
                {hints.map((hint) => (
                  <KeyHint key={hint.keys.join()} keys={hint.keys} label={hint.label} />
                ))}
              </HStack>
            </LayoutFooter>
          ) : undefined
        }
      />
    </Dialog>
  );
}
