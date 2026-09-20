import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Textarea } from '@/components/ui/textarea';

interface GitCommitModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommit: (subject: string, body: string) => Promise<void>;
}

function longBodyLines(body: string): number[] {
  return body
    .split(/\r?\n/)
    .map((line, index) => (line.length > 72 ? index + 1 : null))
    .filter((line): line is number => line !== null);
}

export function GitCommitModal({ open, onOpenChange, onCommit }: GitCommitModalProps) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const longLines = longBodyLines(body);
  const subjectInvalid = attempted && !subject.trim();

  useEffect(() => {
    if (!open) return;
    setSubject('');
    setBody('');
    setAttempted(false);
    setCommitting(false);
    setError(null);
    window.requestAnimationFrame(() => subjectRef.current?.focus());
  }, [open]);

  const commit = async () => {
    const trimmedSubject = subject.trim();
    setAttempted(true);
    if (!trimmedSubject) {
      subjectRef.current?.focus();
      return;
    }

    setCommitting(true);
    setError(null);
    try {
      await onCommit(trimmedSubject, body);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setCommitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      if (document.activeElement === subjectRef.current) bodyRef.current?.focus();
      else subjectRef.current?.focus();
      return;
    }

    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      void commit();
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!committing) onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          subjectRef.current?.focus();
        }}
        onKeyDownCapture={handleKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Commit staged changes</DialogTitle>
        </DialogHeader>

        <FieldGroup>
          <Field data-invalid={subjectInvalid}>
            <FieldLabel htmlFor="git-commit-subject">Subject</FieldLabel>
            <Input
              ref={subjectRef}
              id="git-commit-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Short summary of the change"
              aria-invalid={subjectInvalid}
              required
              disabled={committing}
            />
            {subject.length > 50 && (
              <FieldDescription className="text-[var(--color-yellow)]" aria-live="polite">
                Subject is {subject.length} characters; keep it within 50 when possible.
              </FieldDescription>
            )}
            {subjectInvalid && <FieldError>Subject is required.</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="git-commit-body">Body</FieldLabel>
            <Textarea
              ref={bodyRef}
              id="git-commit-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Explain the change in more detail (optional)"
              rows={8}
              className="resize-y font-mono"
              disabled={committing}
            />
            {longLines.length > 0 && (
              <FieldDescription className="text-[var(--color-yellow)]" aria-live="polite">
                {longLines.length === 1 ? 'One body line' : `${longLines.length} body lines`} exceed 72 columns
                {longLines.length <= 3 ? ` (line${longLines.length === 1 ? '' : 's'} ${longLines.join(', ')})` : ''}.
              </FieldDescription>
            )}
          </Field>
        </FieldGroup>

        {error && <FieldError>{error}</FieldError>}

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <KbdGroup>
                <Kbd>Tab</Kbd>
              </KbdGroup>{' '}
              fields
            </span>
            <span className="flex items-center gap-1">
              <KbdGroup>
                <Kbd>Ctrl+Enter</Kbd>
              </KbdGroup>{' '}
              commit
            </span>
            <span className="flex items-center gap-1">
              <KbdGroup>
                <Kbd>Esc</Kbd>
              </KbdGroup>{' '}
              cancel
            </span>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={committing}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void commit()} disabled={committing || !subject.trim()}>
              {committing ? 'Committing…' : 'Commit'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
