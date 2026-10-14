import type { MailAccount, MailAddress, MailFolder, MailMessageDetail, MailMessageSummary } from '@shared/api-types';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Lock,
  Archive,
  ArrowLeft,
  CornerUpLeft,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  FolderInput,
  ImageOff,
  Inbox,
  Mail,
  MailOpen,
  MailPlus,
  OctagonX,
  Paperclip,
  PenSquare,
  Reply,
  Send,
  Star,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Pagination, RefreshButton, SearchInput } from '@/components/shared/page';
import { EmptyState, ErrorState, QueryBoundary } from '@/components/shared/states';
import { StatusBadge } from '@/components/shared/status-badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Hint } from '@/components/ui/tooltip';
import { attachmentUrl, useDeleteMessage, useMailAccounts, useMailFolders, useMailMessage, useMailMessages, useMoveMessage, useSetFlags } from '@/features/mail/api';
import { ComposeDialog, type ComposeDraft } from '@/features/mail/compose';
import { MessageFrame } from '@/features/mail/message-frame';
import { groupAccounts, VisibilityBadge } from '@/features/mail/visibility-badge';
import { usePreferences } from '@/features/preferences/api';
import { useDebounce } from '@/hooks/use-debounce';
import { useIsDesktop } from '@/hooks/use-media-query';
import { errorMessage, isApiError, isStepUpCancelled } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatBytes, formatDateTime, formatNumber, formatSmartDate } from '@/lib/format';
import { clientStatus } from '@/lib/status';
import { cn, initials } from '@/lib/utils';

const PAGE_SIZE = 30;

const FOLDER_META: Record<NonNullable<MailFolder['specialUse']>, { label: string; icon: LucideIcon; order: number }> = {
  inbox: { label: 'Boîte de réception', icon: Inbox, order: 0 },
  drafts: { label: 'Brouillons', icon: FileText, order: 1 },
  sent: { label: 'Envoyés', icon: Send, order: 2 },
  archive: { label: 'Archives', icon: Archive, order: 3 },
  junk: { label: 'Indésirables', icon: OctagonX, order: 4 },
  trash: { label: 'Corbeille', icon: Trash2, order: 5 },
};

const folderLabel = (folder: MailFolder): string => (folder.specialUse ? FOLDER_META[folder.specialUse].label : folder.name || folder.path);
const folderIcon = (folder: MailFolder): LucideIcon => (folder.specialUse ? FOLDER_META[folder.specialUse].icon : Folder);
const sortFolders = (folders: MailFolder[]): MailFolder[] =>
  [...folders].sort((a, b) => {
    const left = a.specialUse ? FOLDER_META[a.specialUse].order : 10;
    const right = b.specialUse ? FOLDER_META[b.specialUse].order : 10;
    return left - right || folderLabel(a).localeCompare(folderLabel(b), 'fr');
  });

const addressLabel = (address: MailAddress | null | undefined): string => address?.name?.trim() || address?.address || 'Expéditeur inconnu';
const addressList = (addresses: MailAddress[]): string => addresses.map((address) => (address.name ? `${address.name} <${address.address}>` : address.address)).join(', ');

// ───────────────────────────── Dossiers ─────────────────────────────

function FolderNav({ folders, current, onSelect }: { folders: MailFolder[]; current: string; onSelect: (path: string) => void }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {folders.map((folder) => {
        const Icon = folderIcon(folder);
        const active = folder.path === current;
        return (
          <li key={folder.path}>
            <button
              type="button"
              onClick={() => onSelect(folder.path)}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium transition-colors',
                active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{folderLabel(folder)}</span>
              {folder.unread > 0 ? (
                <span className="tabular shrink-0 text-xs font-semibold text-link">
                  {formatNumber(folder.unread)}
                  <span className="sr-only"> non lus</span>
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ───────────────────────────── Liste ─────────────────────────────

function MessageItem({ message, active, sentFolder, onSelect }: { message: MailMessageSummary; active: boolean; sentFolder: boolean; onSelect: () => void }) {
  const who = sentFolder ? `À : ${message.to.map((address) => addressLabel(address)).join(', ') || '—'}` : addressLabel(message.from);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'relative flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors',
        active ? 'bg-accent' : 'hover:bg-muted/50',
        !message.seen && !active && 'bg-primary/[0.035]',
      )}
    >
      {!message.seen ? <span aria-hidden className="absolute left-1.5 top-[18px] size-1.5 rounded-full bg-primary" /> : null}
      <span className="flex items-baseline justify-between gap-3">
        <span className={cn('truncate text-[13px]', message.seen ? 'font-medium text-foreground/85' : 'font-semibold')}>
          {message.seen ? null : <span className="sr-only">Non lu : </span>}
          {who}
        </span>
        <span className={cn('tabular shrink-0 text-xs', message.seen ? 'text-muted-foreground' : 'font-medium text-link')}>{formatSmartDate(message.date)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', message.seen ? 'text-foreground/80' : 'font-semibold')}>{message.subject || '(sans objet)'}</span>
        {message.answered ? <CornerUpLeft className="size-3.5 shrink-0 text-muted-foreground" aria-label="Répondu" /> : null}
        {message.hasAttachments ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pièce jointe" /> : null}
        {message.flagged ? <Star className="size-3.5 shrink-0 fill-warning text-warning" aria-label="Suivi" /> : null}
      </span>
      <span className="line-clamp-1 text-xs text-muted-foreground">{message.preview}</span>
    </button>
  );
}

function ListSkeleton() {
  return (
    <ul className="divide-y" aria-hidden>
      {Array.from({ length: 9 }, (_, index) => (
        <li key={index} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex justify-between gap-3">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-10" />
          </div>
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────── Lecture ─────────────────────────────

function ReaderSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-5" aria-busy aria-label="Chargement du message">
      <Skeleton className="h-6 w-3/5" />
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      </div>
      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  );
}

interface ReaderProps {
  accountId: number;
  message: MailMessageDetail;
  folders: MailFolder[];
  onBack?: () => void;
  onReply: (message: MailMessageDetail) => void;
  onGone: () => void;
}

function Reader({ accountId, message, folders, onBack, onReply, onGone }: ReaderProps) {
  const setFlags = useSetFlags();
  const move = useMoveMessage();
  const remove = useDeleteMessage();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = { accountId, folder: message.folder, uid: message.uid };
  const destinations = folders.filter((folder) => folder.path !== message.folder && folder.specialUse !== 'drafts');
  const inTrash = folders.find((folder) => folder.path === message.folder)?.specialUse === 'trash';

  const onError = (title: string) => (error: unknown) => {
    if (!isStepUpCancelled(error)) toast.error(title, { description: errorMessage(error) });
  };

  const markUnread = () => {
    setFlags.mutate({ ...ref, flags: { seen: false } }, { onError: onError('Action impossible') });
    onGone();
  };

  const moveTo = (folder: MailFolder) =>
    move.mutate(
      { ...ref, destination: folder.path },
      {
        onSuccess: () => {
          toast.success(`Message déplacé vers « ${folderLabel(folder)} »`);
          onGone();
        },
        onError: onError('Déplacement impossible'),
      },
    );

  const doDelete = () => {
    setConfirmDelete(false);
    remove.mutate(ref, {
      onSuccess: () => {
        toast.success(inTrash ? 'Message supprimé définitivement' : 'Message placé dans la corbeille');
        onGone();
      },
      onError: onError('Suppression impossible'),
    });
  };

  return (
    <motion.article key={`${message.folder}-${message.uid}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5 sm:px-3">
        {onBack ? (
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Retour à la liste">
            <ArrowLeft aria-hidden />
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => onReply(message)}>
          <Reply aria-hidden />
          Répondre
        </Button>
        <div className="ml-auto flex items-center gap-0.5">
          <Hint label="Marquer comme non lu">
            <Button variant="ghost" size="icon" onClick={markUnread} aria-label="Marquer comme non lu">
              <Mail aria-hidden />
            </Button>
          </Hint>
          <Hint label={message.flagged ? 'Ne plus suivre' : 'Suivre'}>
            <Button
              variant="ghost"
              size="icon"
              aria-pressed={message.flagged}
              aria-label={message.flagged ? 'Ne plus suivre ce message' : 'Suivre ce message'}
              onClick={() => setFlags.mutate({ ...ref, flags: { flagged: !message.flagged } }, { onError: onError('Action impossible') })}
            >
              <Star className={cn(message.flagged && 'fill-warning text-warning')} aria-hidden />
            </Button>
          </Hint>
          <DropdownMenu>
            <Hint label="Déplacer">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Déplacer vers un dossier" disabled={destinations.length === 0 || move.isPending}>
                  <FolderInput aria-hidden />
                </Button>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
              <DropdownMenuLabel>Déplacer vers</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {destinations.map((folder) => {
                const Icon = folderIcon(folder);
                return (
                  <DropdownMenuItem key={folder.path} onSelect={() => moveTo(folder)}>
                    <Icon aria-hidden />
                    {folderLabel(folder)}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <Hint label="Supprimer">
            <Button variant="ghost" size="icon" className="hover:text-danger" onClick={() => setConfirmDelete(true)} aria-label="Supprimer le message" disabled={remove.isPending}>
              <Trash2 aria-hidden />
            </Button>
          </Hint>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-5">
        <h2 className="break-words text-lg font-semibold leading-snug">{message.subject || '(sans objet)'}</h2>

        <div className="flex items-start gap-3">
          <Avatar className="size-10">
            <AvatarFallback>{initials(addressLabel(message.from))}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="break-words text-sm font-medium">{addressLabel(message.from)}</p>
              <time dateTime={message.date} className="tabular shrink-0 text-xs text-muted-foreground">
                {formatDateTime(message.date)}
              </time>
            </div>
            {message.from?.name ? <p className="break-all text-xs text-muted-foreground">{message.from.address}</p> : null}
            <p className="break-words text-xs text-muted-foreground">À : {addressList(message.to) || '—'}</p>
            {message.cc.length > 0 ? <p className="break-words text-xs text-muted-foreground">Cc : {addressList(message.cc)}</p> : null}
          </div>
        </div>

        {message.whmcsClient ? (
          <Link
            to={`/whmcs/clients/${message.whmcsClient.id}`}
            className="flex items-center gap-3 rounded-xl border bg-muted/40 px-3.5 py-2.5 transition-colors hover:bg-muted"
            aria-label={`Ouvrir la fiche client WHMCS de ${message.whmcsClient.name}`}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground">
              <UserRound className="size-4" aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Client WHMCS</span>
              <span className="truncate text-[13px] font-medium">
                {message.whmcsClient.name}
                {message.whmcsClient.companyName ? <span className="font-normal text-muted-foreground"> · {message.whmcsClient.companyName}</span> : null}
              </span>
            </span>
            <StatusBadge status={clientStatus(message.whmcsClient.status)} />
            <span className="hidden text-xs font-medium text-link sm:inline">Voir la fiche</span>
          </Link>
        ) : null}

        {message.remoteContentBlocked ? (
          <p role="status" className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <ImageOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Images distantes bloquées : elles ne sont jamais chargées, pour que l'expéditeur ne sache pas que vous avez ouvert ce message.
          </p>
        ) : null}

        {message.html ? (
          <MessageFrame html={message.html} title={`Contenu du message : ${message.subject || 'sans objet'}`} className="min-h-[55dvh] flex-1" />
        ) : message.text ? (
          <pre className="whitespace-pre-wrap break-words rounded-lg border bg-card p-4 font-sans text-[13px] leading-relaxed">{message.text}</pre>
        ) : (
          <p className="rounded-lg border border-dashed p-6 text-center text-[13px] text-muted-foreground">Ce message n'a pas de contenu affichable.</p>
        )}

        {message.attachments.length > 0 ? (
          <section aria-label="Pièces jointes" className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Paperclip className="size-3.5" aria-hidden />
              {message.attachments.length} pièce{message.attachments.length > 1 ? 's' : ''} jointe{message.attachments.length > 1 ? 's' : ''}
            </h3>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {message.attachments.map((attachment) => (
                <li key={attachment.id}>
                  {/* Lien de téléchargement simple vers la route authentifiée : le serveur force le téléchargement. */}
                  <a
                    href={attachmentUrl(accountId, message.folder, message.uid, attachment.id)}
                    download={attachment.filename}
                    rel="noopener noreferrer"
                    className="flex min-h-12 items-center gap-3 rounded-lg border bg-card px-3 py-2 transition-colors hover:bg-muted/60"
                  >
                    <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] font-medium">{attachment.filename}</span>
                      <span className="tabular text-xs text-muted-foreground">{formatBytes(attachment.size)}</span>
                    </span>
                    <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="sr-only">Télécharger</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={inTrash ? 'Supprimer définitivement ce message ?' : 'Supprimer ce message ?'}
        description={inTrash ? 'Le message sera effacé du serveur de messagerie. Cette action est irréversible.' : 'Le message sera déplacé dans la corbeille du compte.'}
        confirmLabel="Supprimer"
        destructive
        onConfirm={doDelete}
      />
    </motion.article>
  );
}

// ───────────────────────────── Page ─────────────────────────────

function Workspace({ accounts, defaultAccountId }: { accounts: MailAccount[]; defaultAccountId: number | null }) {
  const isDesktop = useIsDesktop();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const accountParam = Number.parseInt(params.get('account') ?? '', 10);
  // Boîte demandée dans l'URL, sinon la boîte par défaut du compte (si elle est toujours accessible), sinon la première.
  const account = accounts.find((item) => item.id === accountParam) ?? accounts.find((item) => item.id === defaultAccountId) ?? accounts[0];
  const groups = useMemo(() => groupAccounts(accounts), [accounts]);
  const accountId = account?.id ?? null;
  const folder = params.get('folder') || 'INBOX';
  const uidParam = Number.parseInt(params.get('uid') ?? '', 10);
  const uid = Number.isInteger(uidParam) && uidParam > 0 ? uidParam : null;
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);

  const [searchInput, setSearchInput] = useState(params.get('q') ?? '');
  const search = useDebounce(searchInput.trim(), 400);
  const [compose, setCompose] = useState<{ open: boolean; draft: ComposeDraft }>({ open: false, draft: {} });

  const update = (changes: Record<string, string | null>, replace = true) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace },
    );

  const folders = useMailFolders(accountId);
  const messages = useMailMessages(accountId, { folder, page, pageSize: PAGE_SIZE, search });
  const message = useMailMessage(accountId, folder, uid);
  const setFlags = useSetFlags();
  const sorted = useMemo(() => sortFolders(folders.data ?? []), [folders.data]);
  const currentFolder = sorted.find((item) => item.path === folder);
  const sentFolder = currentFolder?.specialUse === 'sent' || currentFolder?.specialUse === 'drafts';

  // La recherche ramène à la première page.
  const lastSearch = useRef(search);
  useEffect(() => {
    if (lastSearch.current !== search) {
      lastSearch.current = search;
      update({ q: search || null, page: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // « Nouveau message » depuis la recherche globale (?compose=1).
  useEffect(() => {
    if (params.get('compose') === '1') {
      setCompose({ open: true, draft: {} });
      update({ compose: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Lire un message le marque comme lu (une seule fois par message ouvert).
  const marked = useRef<string | null>(null);
  useEffect(() => {
    const data = message.data;
    if (!data || accountId === null || data.uid !== uid) return;
    const key = `${accountId}:${data.folder}:${data.uid}`;
    if (!data.seen && marked.current !== key) {
      marked.current = key;
      setFlags.mutate({ accountId, folder: data.folder, uid: data.uid, flags: { seen: true } });
    }
  }, [message.data, accountId, uid, setFlags]);

  const lost = isApiError(folders.error) && folders.error.code === 'NOT_FOUND' ? folders.error : isApiError(messages.error) && messages.error.code === 'NOT_FOUND' ? messages.error : null;
  const handledLoss = useRef<number | null>(null);
  useEffect(() => {
    if (!lost || accountId === null || handledLoss.current === accountId) return;
    handledLoss.current = accountId;
    toast.warning("Cette boîte mail n'est plus accessible", { description: "Elle a été supprimée ou rendue personnelle par l'autre administrateur." });
    client.removeQueries({ queryKey: qk.mail.folders(accountId) });
    client.removeQueries({ queryKey: qk.mail.messagesRoot(accountId) });
    void client.invalidateQueries({ queryKey: qk.mail.accounts });
    void client.invalidateQueries({ queryKey: qk.mail.summary });
    setParams({}, { replace: true });
  }, [lost, accountId, client, setParams]);

  if (!account || accountId === null) return null;

  const selectAccount = (value: string) => {
    setSearchInput('');
    setParams({ account: value }, { replace: true });
  };
  const selectFolder = (path: string) => {
    setSearchInput('');
    update({ folder: path === 'INBOX' ? null : path, uid: null, page: null, q: null });
  };
  const closeMessage = () => update({ uid: null });
  const refresh = () => {
    void folders.refetch();
    void messages.refetch();
  };

  const accountSelect = (
    <Select value={String(accountId)} onValueChange={selectAccount}>
      <SelectTrigger aria-label="Compte de messagerie" className="h-10 font-medium">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {groups.mine.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Mes boîtes</SelectLabel>
            {groups.mine.map((item) => (
              <SelectItem key={item.id} value={String(item.id)}>
                <span className="flex items-center gap-2">
                  {item.label}
                  <Lock className="size-3 text-link" aria-label="personnelle" />
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {groups.shared.length > 0 ? (
          <SelectGroup>
            {groups.mine.length > 0 ? <SelectLabel>Boîtes partagées</SelectLabel> : null}
            {groups.shared.map((item) => (
              <SelectItem key={item.id} value={String(item.id)}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );

  const composeButton = (
    <Button onClick={() => setCompose({ open: true, draft: {} })} className="w-full">
      <PenSquare aria-hidden />
      Nouveau message
    </Button>
  );

  const list = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b p-3">
        {isDesktop ? (
          <div className="flex items-center justify-between gap-2 px-1">
            <h2 className="truncate text-sm font-semibold">{currentFolder ? folderLabel(currentFolder) : folder === 'INBOX' ? 'Boîte de réception' : folder}</h2>
            <RefreshButton onClick={refresh} loading={messages.isFetching} />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">{accountSelect}</div>
              <RefreshButton onClick={refresh} loading={messages.isFetching} />
              <Button size="icon" onClick={() => setCompose({ open: true, draft: {} })} aria-label="Nouveau message">
                <MailPlus aria-hidden />
              </Button>
            </div>
            <Select value={folder} onValueChange={selectFolder}>
              <SelectTrigger aria-label="Dossier">
                <SelectValue placeholder="Dossier" />
              </SelectTrigger>
              <SelectContent>
                {(sorted.length > 0 ? sorted : [{ path: folder, name: folder, specialUse: null, unread: 0, total: 0 } satisfies MailFolder]).map((item) => (
                  <SelectItem key={item.path} value={item.path}>
                    {folderLabel(item)}
                    {item.unread > 0 ? ` (${item.unread})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <SearchInput value={searchInput} onChange={setSearchInput} placeholder="Rechercher dans ce dossier…" className="sm:max-w-none" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <QueryBoundary query={messages} integration="mail" compact skeleton={<ListSkeleton />}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState
                compact
                icon={search ? Mail : MailOpen}
                title={search ? 'Aucun message trouvé' : 'Dossier vide'}
                description={search ? `Aucun message ne correspond à « ${search} » dans ce dossier.` : 'Aucun message dans ce dossier pour le moment.'}
              />
            ) : (
              <ul className={cn('divide-y transition-opacity', messages.isPlaceholderData && 'opacity-60')}>
                {data.items.map((item) => (
                  <li key={`${item.folder}-${item.uid}`}>
                    <MessageItem message={item} active={item.uid === uid} sentFolder={Boolean(sentFolder)} onSelect={() => update({ uid: String(item.uid) }, uid !== null)} />
                  </li>
                ))}
              </ul>
            )
          }
        </QueryBoundary>
      </div>
      {messages.data && messages.data.meta.total > PAGE_SIZE ? (
        <Pagination className="shrink-0 border-t py-2" page={messages.data.meta.page} pageSize={messages.data.meta.pageSize} total={messages.data.meta.total} onPageChange={(next) => update({ page: next <= 1 ? null : String(next), uid: null })} noun="message" />
      ) : null}
    </div>
  );

  const reader =
    uid === null ? (
      <EmptyState icon={MailOpen} title="Sélectionnez un message" description="Choisissez un message dans la liste pour le lire ici." className="h-full" />
    ) : (
      <QueryBoundary query={message} integration="mail" skeleton={<ReaderSkeleton />}>
        {(data) => (
          <Reader
            accountId={accountId}
            message={data}
            folders={sorted}
            onBack={isDesktop ? undefined : closeMessage}
            onReply={(original) => setCompose({ open: true, draft: { replyTo: original } })}
            onGone={closeMessage}
          />
        )}
      </QueryBoundary>
    );

  return (
    <>
      {isDesktop ? (
        <div className="grid h-[calc(100dvh-3.5rem)] grid-cols-[232px_minmax(300px,380px)_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col gap-3 border-r bg-sidebar/60 p-3" aria-label="Comptes et dossiers">
            {accountSelect}
            {composeButton}
            <div className="flex min-w-0 items-center justify-between gap-2 px-1">
              <p className="truncate text-xs text-muted-foreground" title={account.address}>
                {account.address}
              </p>
              <VisibilityBadge account={account} className="shrink-0" />
            </div>
            <nav aria-label="Dossiers" className="min-h-0 flex-1 overflow-y-auto">
              {folders.data ? (
                <FolderNav folders={sorted} current={folder} onSelect={selectFolder} />
              ) : folders.isError ? (
                <ErrorState compact error={folders.error} onRetry={() => void folders.refetch()} />
              ) : (
                <div className="flex flex-col gap-2 px-1" aria-hidden>
                  {[0, 1, 2, 3, 4].map((index) => (
                    <Skeleton key={index} className="h-7" />
                  ))}
                </div>
              )}
            </nav>
          </aside>
          <section className="min-h-0 border-r" aria-label="Liste des messages">
            {list}
          </section>
          <section className="min-h-0 min-w-0 bg-card/40" aria-label="Lecture du message">
            {reader}
          </section>
        </div>
      ) : (
        <div className="h-[calc(100dvh-3.5rem)]">{uid === null ? list : reader}</div>
      )}

      <ComposeDialog open={compose.open} onClose={() => setCompose((current) => ({ ...current, open: false }))} accounts={accounts} defaultAccountId={accountId} draft={compose.draft} />
    </>
  );
}

export default function MailPage() {
  const accounts = useMailAccounts();
  const preferences = usePreferences();
  // On attend les préférences (boîte par défaut) pour ne pas ouvrir une boîte puis basculer sur une autre.
  const ready = preferences.data !== undefined || preferences.isError;
  return (
    <QueryBoundary
      query={accounts}
      integration="mail"
      skeleton={
        <div className="grid h-[calc(100dvh-3.5rem)] grid-cols-1 lg:grid-cols-[232px_380px_1fr]" aria-busy aria-label="Chargement des mails">
          <div className="hidden flex-col gap-3 border-r p-3 lg:flex">
            <Skeleton className="h-10" />
            <Skeleton className="h-9" />
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-7" />
            ))}
          </div>
          <div className="border-r">
            <ListSkeleton />
          </div>
          <div className="hidden lg:block">
            <ReaderSkeleton />
          </div>
        </div>
      }
    >
      {(data) =>
        data.length === 0 ? (
          <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center">
            <EmptyState
              icon={Inbox}
              title="Aucun compte mail configuré"
              description="Ajoutez vos boîtes (support, contact, facturation…) pour lire et répondre à vos mails sans quitter le panel."
              action={
                <Button asChild>
                  <Link to="/settings#mail">Ajouter un compte mail</Link>
                </Button>
              }
            />
          </div>
        ) : (
          ready ? <Workspace accounts={data} defaultAccountId={preferences.data?.mail.defaultAccountId ?? null} /> : <ListSkeleton />
        )
      }
    </QueryBoundary>
  );
}
