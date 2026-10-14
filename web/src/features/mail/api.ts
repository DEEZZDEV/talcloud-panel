import type {
  MailAccount,
  MailAccountInput,
  MailFlagsRequest,
  MailFolder,
  MailMessageDetail,
  MailMessageSummary,
  MailMoveRequest,
  MailSendRequest,
  MailSendResult,
  MailUnreadSummary,
  SettingsTestResult,
} from '@shared/api-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, buildUrl } from '@/lib/api';
import { fetcher, keepPreviousData, pageFetcher, qk, type Page } from '@/lib/query';

const accountPath = (accountId: number) => `/api/mail/accounts/${encodeURIComponent(String(accountId))}`;
const messagePath = (accountId: number, uid: number) => `${accountPath(accountId)}/messages/${encodeURIComponent(String(uid))}`;

export const useMailAccounts = () => useQuery({ queryKey: qk.mail.accounts, queryFn: fetcher<MailAccount[]>('/api/mail/accounts'), staleTime: 5 * 60_000 });

export const useMailUnreadSummary = () =>
  useQuery({ queryKey: qk.mail.summary, queryFn: fetcher<MailUnreadSummary>('/api/mail/unread-summary'), staleTime: 60_000, refetchInterval: 2 * 60_000 });

export const useMailFolders = (accountId: number | null) =>
  useQuery({
    queryKey: qk.mail.folders(accountId ?? 0),
    queryFn: fetcher<MailFolder[]>(`${accountPath(accountId ?? 0)}/folders`),
    enabled: accountId !== null,
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  });

export interface MessageListParams {
  folder: string;
  page: number;
  pageSize: number;
  search?: string;
}

export function useMailMessages(accountId: number | null, params: MessageListParams) {
  const query = { folder: params.folder, page: params.page, pageSize: params.pageSize, search: params.search?.trim() || undefined };
  return useQuery({
    queryKey: qk.mail.messages(accountId ?? 0, query),
    queryFn: pageFetcher<MailMessageSummary>(`${accountPath(accountId ?? 0)}/messages`, query),
    enabled: accountId !== null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: 90_000,
  });
}

export const useMailMessage = (accountId: number | null, folder: string, uid: number | null) =>
  useQuery({
    queryKey: qk.mail.message(accountId ?? 0, folder, uid ?? 0),
    queryFn: fetcher<MailMessageDetail>(messagePath(accountId ?? 0, uid ?? 0), { folder }),
    enabled: accountId !== null && uid !== null,
    staleTime: 5 * 60_000,
  });

/** Lien de téléchargement d'une pièce jointe (route authentifiée, même origine). */
export const attachmentUrl = (accountId: number, folder: string, uid: number, attachmentId: string): string =>
  buildUrl(`${messagePath(accountId, uid)}/attachments/${encodeURIComponent(attachmentId)}`, { folder });

interface MessageRef {
  accountId: number;
  folder: string;
  uid: number;
}

function useInvalidateMailbox() {
  const client = useQueryClient();
  return (accountId: number) => {
    void client.invalidateQueries({ queryKey: qk.mail.messagesRoot(accountId) });
    void client.invalidateQueries({ queryKey: qk.mail.folders(accountId) });
    void client.invalidateQueries({ queryKey: qk.mail.summary });
  };
}

export function useSetFlags() {
  const client = useQueryClient();
  const invalidate = useInvalidateMailbox();
  return useMutation({
    mutationFn: ({ accountId, folder, uid, flags }: MessageRef & { flags: MailFlagsRequest }) => api.post(`${messagePath(accountId, uid)}/flags`, flags, { query: { folder } }),
    onMutate: ({ accountId, folder, uid, flags }) => {
      // Mise à jour immédiate de la liste et du message ouvert.
      client.setQueriesData<Page<MailMessageSummary>>({ queryKey: qk.mail.messagesRoot(accountId) }, (page) =>
        page ? { ...page, items: page.items.map((message) => (message.uid === uid && message.folder === folder ? { ...message, ...flags } : message)) } : page,
      );
      client.setQueryData<MailMessageDetail>(qk.mail.message(accountId, folder, uid), (message) => (message ? { ...message, ...flags } : message));
    },
    onSettled: (_data, _error, { accountId }) => invalidate(accountId),
  });
}

export function useMoveMessage() {
  const invalidate = useInvalidateMailbox();
  return useMutation({
    mutationFn: ({ accountId, folder, uid, destination }: MessageRef & MailMoveRequest) => api.post(`${messagePath(accountId, uid)}/move`, { destination } satisfies MailMoveRequest, { query: { folder } }),
    onSettled: (_data, _error, { accountId }) => invalidate(accountId),
  });
}

export function useDeleteMessage() {
  const invalidate = useInvalidateMailbox();
  return useMutation({
    mutationFn: ({ accountId, folder, uid }: MessageRef) => api.delete(messagePath(accountId, uid), { query: { folder } }),
    onSettled: (_data, _error, { accountId }) => invalidate(accountId),
  });
}

export function useSendMail() {
  const invalidate = useInvalidateMailbox();
  return useMutation({
    mutationFn: ({ accountId, message }: { accountId: number; message: MailSendRequest }) => api.post<MailSendResult>(`${accountPath(accountId)}/send`, message),
    onSuccess: (_data, { accountId }) => invalidate(accountId),
  });
}

// ── Comptes (réglages) ──

function useInvalidateAccounts() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: qk.mail.all });
}

export function useSaveMailAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: MailAccountInput }) =>
      id === null ? api.post<MailAccount>('/api/mail/accounts', input) : api.put<MailAccount>(accountPath(id), input),
    onSuccess: invalidate,
  });
}

export function useDeleteMailAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({ mutationFn: (id: number) => api.delete(accountPath(id)), onSuccess: invalidate });
}

export const useTestMailAccount = () => useMutation({ mutationFn: (id: number) => api.post<SettingsTestResult>(`${accountPath(id)}/test`) });
