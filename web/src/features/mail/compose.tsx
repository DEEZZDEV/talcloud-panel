import type { MailAccount, MailMessageDetail, MailSendRequest } from '@shared/api-types';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Paperclip, Send, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fieldClasses, Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useSendMail } from '@/features/mail/api';
import { errorMessage, isStepUpCancelled } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

// Limites du serveur : 50 destinataires au total, objet de 500 caractères, 10 pièces jointes / 10 Mo.
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Adresse nue en ASCII (le serveur refuse les noms affichés et les caractères accentués). */
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export interface ComposeDraft {
  /** Message auquel on répond (définit les en-têtes de fil et le marque « répondu »). */
  replyTo?: MailMessageDetail;
}

interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentBase64: string;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

function quote(message: MailMessageDetail): string {
  const date = Number.isFinite(Date.parse(message.date)) ? format(new Date(message.date), "d MMMM yyyy 'à' HH:mm", { locale: fr }) : '';
  const author = message.from?.name || message.from?.address || 'votre correspondant';
  const body = (message.text ?? message.preview ?? '').trim().slice(0, 20_000);
  const quoted = body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  return `\n\n\nLe ${date}, ${author} a écrit :\n${quoted}`;
}

/** Champ de destinataires : adresses validées et affichées en pastilles. */
function RecipientsField({ id, label, values, onChange, autoFocus }: { id: string; label: string; values: string[]; onChange: (values: string[]) => void; autoFocus?: boolean }) {
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  const commit = (raw: string): boolean => {
    const parts = raw
      .split(/[\s,;]+/)
      .map((part) => part.trim().replace(/^<|>$/g, ''))
      .filter(Boolean);
    if (parts.length === 0) return true;
    const bad = parts.find((part) => !EMAIL.test(part) || part.length > 254);
    if (bad) {
      setInvalid(`« ${bad} » n'est pas une adresse valide (adresse simple, sans accent).`);
      return false;
    }
    const next = [...values];
    for (const part of parts) if (!next.some((value) => value.toLowerCase() === part.toLowerCase())) next.push(part);
    onChange(next);
    setDraft('');
    setInvalid(null);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'Enter' || event.key === ',' || event.key === ';' || event.key === ' ') && draft.trim()) {
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className={cn(fieldClasses, 'h-auto min-h-10 flex-wrap items-center gap-1.5 py-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25 sm:min-h-9', invalid && 'border-danger')}>
        {values.map((value) => (
          <span key={value} className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border bg-muted pl-2 pr-0.5 text-[13px]">
            <span className="truncate">{value}</span>
            <button type="button" onClick={() => onChange(values.filter((item) => item !== value))} className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground" aria-label={`Retirer ${value}`}>
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="email"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (invalid) setInvalid(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (/[\s,;]/.test(text.trim())) {
              event.preventDefault();
              commit(text);
            }
          }}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={values.length === 0 ? 'adresse@exemple.com' : ''}
          aria-invalid={invalid !== null}
          aria-describedby={invalid ? `${id}-error` : undefined}
          className="h-7 min-w-[10rem] flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
        />
      </div>
      {invalid ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger">
          {invalid}
        </p>
      ) : null}
    </div>
  );
}

interface ComposeDialogProps {
  open: boolean;
  onClose: () => void;
  accounts: MailAccount[];
  defaultAccountId: number | null;
  draft: ComposeDraft;
}

/** Nouveau message ou réponse : texte brut, destinataires, pièces jointes. L'expéditeur est toujours l'adresse du compte choisi. */
export function ComposeDialog({ open, onClose, accounts, defaultAccountId, draft }: ComposeDialogProps) {
  const ids = { to: useId(), cc: useId(), bcc: useId(), subject: useId(), text: useId(), from: useId() };
  const send = useSendMail();
  const fileInput = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const [accountId, setAccountId] = useState<number | null>(defaultAccountId);
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reply = draft.replyTo;

  // Préremplissage à chaque ouverture.
  useEffect(() => {
    if (!open) return;
    setAccountId(defaultAccountId ?? accounts[0]?.id ?? null);
    setCc([]);
    setBcc([]);
    setShowCopies(false);
    setAttachments([]);
    setError(null);
    if (reply) {
      const target = reply.replyTo[0]?.address ?? reply.from?.address ?? '';
      setTo(EMAIL.test(target) ? [target] : []);
      const original = reply.subject.trim();
      setSubject((/^re\s*:/i.test(original) ? original : `Re: ${original}`).slice(0, 500));
      setText(quote(reply));
    } else {
      setTo([]);
      setSubject('');
      setText('');
    }
    // Réponse : le curseur se place AVANT la citation, pour écrire directement sa réponse.
    if (reply) {
      window.setTimeout(() => {
        const area = textArea.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(0, 0);
        area.scrollTop = 0;
      }, 60);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const next = [...attachments];
    let bytes = totalBytes;
    for (const file of Array.from(files)) {
      if (next.length >= MAX_ATTACHMENTS) {
        toast.error(`${MAX_ATTACHMENTS} pièces jointes au maximum.`);
        break;
      }
      if (file.size === 0) continue;
      if (bytes + file.size > MAX_ATTACHMENT_BYTES) {
        toast.error('Pièces jointes trop volumineuses', { description: '10 Mo au total par message.' });
        break;
      }
      try {
        const contentBase64 = await readFile(file);
        bytes += file.size;
        next.push({ id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`, filename: file.name.slice(0, 255), contentType: (file.type || 'application/octet-stream').slice(0, 255), size: file.size, contentBase64 });
      } catch {
        toast.error(`Lecture impossible : ${file.name}`);
      }
    }
    setAttachments(next);
    if (fileInput.current) fileInput.current.value = '';
  };

  const submit = async () => {
    if (accountId === null) return setError("Choisissez le compte d'envoi.");
    if (to.length === 0) return setError('Ajoutez au moins un destinataire.');
    if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) return setError(`${MAX_RECIPIENTS} destinataires au maximum.`);
    if (!subject.trim() && !text.trim()) return setError('Le message est vide.');
    setError(null);
    // Corps strict côté serveur : uniquement les champs du contrat.
    const message: MailSendRequest = { to, subject: subject.replace(/[\r\n\t]+/g, ' ').trim(), text };
    if (cc.length > 0) message.cc = cc;
    if (bcc.length > 0) message.bcc = bcc;
    if (reply) message.inReplyTo = { folder: reply.folder, uid: reply.uid };
    if (attachments.length > 0) message.attachments = attachments.map(({ filename, contentType, contentBase64 }) => ({ filename, contentType, contentBase64 }));
    try {
      await send.mutateAsync({ accountId, message });
      toast.success('Message envoyé', { description: to.join(', ') });
      onClose();
    } catch (cause) {
      if (!isStepUpCancelled(cause)) setError(errorMessage(cause, "L'envoi a échoué."));
    }
  };

  const account = accounts.find((item) => item.id === accountId);

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !send.isPending ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl gap-0 p-0 sm:p-0" onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{reply ? 'Répondre' : 'Nouveau message'}</DialogTitle>
          <DialogDescription>{account ? `Envoyé depuis ${account.address}` : 'Message en texte brut'}</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <div className="flex flex-col gap-4 px-5 py-4">
            {accounts.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.from}>De</Label>
                <Select value={accountId === null ? undefined : String(accountId)} onValueChange={(value) => setAccountId(Number(value))} disabled={Boolean(reply)}>
                  <SelectTrigger id={ids.from}>
                    <SelectValue placeholder="Choisir un compte" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)}>
                        {item.label} — {item.address}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="relative">
              <RecipientsField id={ids.to} label="À" values={to} onChange={setTo} autoFocus={!reply} />
              {showCopies ? null : (
                <Button variant="link" className="absolute right-0 top-0 text-xs" onClick={() => setShowCopies(true)}>
                  Cc / Cci
                </Button>
              )}
            </div>
            {showCopies ? (
              <>
                <RecipientsField id={ids.cc} label="Cc" values={cc} onChange={setCc} />
                <RecipientsField id={ids.bcc} label="Cci" values={bcc} onChange={setBcc} />
              </>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.subject}>Objet</Label>
              <Input id={ids.subject} value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={500} autoComplete="off" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.text}>Message</Label>
              <Textarea id={ids.text} value={text} onChange={(event) => setText(event.target.value)} rows={10} maxLength={200_000} ref={textArea} className="min-h-[200px] resize-y" />
            </div>

            {attachments.length > 0 ? (
              <ul className="flex flex-wrap gap-2" aria-label="Pièces jointes">
                {attachments.map((attachment) => (
                  <li key={attachment.id} className="inline-flex max-w-full items-center gap-2 rounded-lg border bg-muted/50 py-1 pl-2.5 pr-1 text-[13px]">
                    <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{attachment.filename}</span>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">{formatBytes(attachment.size)}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                      className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                      aria-label={`Retirer ${attachment.filename}`}
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {error ? (
              <p role="alert" className="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[13px] text-danger">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter className="items-center border-t px-5 py-3 sm:justify-between">
            <div className="flex items-center gap-2">
              <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => void addFiles(event.target.files)} />
              <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={attachments.length >= MAX_ATTACHMENTS}>
                <Paperclip aria-hidden />
                Joindre
              </Button>
              <span className="tabular text-xs text-muted-foreground">
                {attachments.length > 0 ? `${attachments.length} fichier${attachments.length > 1 ? 's' : ''} · ${formatBytes(totalBytes)} / 10 Mo` : '10 Mo max.'}
              </span>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" onClick={onClose} disabled={send.isPending}>
                Annuler
              </Button>
              <Button type="submit" loading={send.isPending}>
                {send.isPending ? null : <Send aria-hidden />}
                Envoyer
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
