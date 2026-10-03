import { useEffect, useRef, useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TextArea } from '@astryxdesign/core/TextArea';
import { Banner } from '@astryxdesign/core/Banner';
import { Layout, LayoutContent, LayoutFooter, HStack } from '@astryxdesign/core/Layout';

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

  const handleOpenChange = (nextOpen: boolean) => {
    if (!committing) onOpenChange(nextOpen);
  };

  return (
    <Dialog
      isOpen={open}
      onOpenChange={handleOpenChange}
      purpose="form"
      width={640}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' && event.ctrlKey && !event.nativeEvent.isComposing && !committing) {
          event.preventDefault();
          void commit();
        }
      }}
    >
      <Layout
        header={<DialogHeader title="Commit staged changes" onOpenChange={handleOpenChange} />}
        content={
          <LayoutContent padding={4}>
            <FormLayout>
              <TextInput
                ref={subjectRef}
                label="Subject"
                value={subject}
                onChange={setSubject}
                hasAutoFocus
                isRequired
                isDisabled={committing}
                placeholder="Short summary of the change"
                status={
                  subjectInvalid
                    ? { type: 'error', message: 'Subject is required.' }
                    : subject.length > 50
                      ? {
                          type: 'warning',
                          message: `Subject is ${subject.length} characters; keep it within 50 when possible.`,
                        }
                      : undefined
                }
              />
              <TextArea
                label="Body"
                value={body}
                onChange={setBody}
                rows={8}
                isDisabled={committing}
                placeholder="Explain the change in more detail (optional)"
                status={
                  longLines.length
                    ? { type: 'warning', message: `${longLines.length} body lines exceed 72 columns.` }
                    : undefined
                }
              />
              {error && <Banner status="error" title={error} />}
            </FormLayout>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" onClick={() => handleOpenChange(false)} isDisabled={committing} />
              <Button
                label="Commit"
                variant="primary"
                onClick={() => void commit()}
                isLoading={committing}
                isDisabled={!subject.trim()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
