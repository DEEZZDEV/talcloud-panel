import type { AuditEntry, BackupCodes, BackupCodesStatus, ChangePasswordRequest, IpAllowlist, IpAllowlistUpdate, KnownDevice, SessionInfo, TotpSetup } from '@shared/api-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fetcher, keepPreviousData, pageFetcher, qk } from '@/lib/query';

export const useSessions = () => useQuery({ queryKey: qk.security.sessions, queryFn: fetcher<SessionInfo[]>('/api/security/sessions'), staleTime: 15_000 });
export const useDevices = () => useQuery({ queryKey: qk.security.devices, queryFn: fetcher<KnownDevice[]>('/api/security/devices'), staleTime: 30_000 });
export const useIpAllowlist = () => useQuery({ queryKey: qk.security.allowlist, queryFn: fetcher<IpAllowlist>('/api/security/ip-allowlist'), staleTime: 30_000 });
export const useBackupCodesStatus = () => useQuery({ queryKey: qk.security.backupCodes, queryFn: fetcher<BackupCodesStatus>('/api/security/backup-codes'), staleTime: 30_000 });

export interface AuditFilters {
  action: string;
  success: 'all' | 'true' | 'false';
  page: number;
  pageSize: number;
}

export function useAudit(filters: AuditFilters) {
  const query = {
    action: /^[a-zA-Z0-9_.-]{1,80}$/.test(filters.action) ? filters.action : undefined,
    success: filters.success === 'all' ? undefined : filters.success,
    page: filters.page,
    pageSize: filters.pageSize,
  };
  return useQuery({ queryKey: qk.security.audit(query), queryFn: pageFetcher<AuditEntry>('/api/security/audit', query), placeholderData: keepPreviousData, staleTime: 15_000 });
}

function useInvalidateSecurity() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: qk.security.all });
}

export function useRevokeSession() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: (id: string) => api.delete(`/api/security/sessions/${encodeURIComponent(id)}`), onSuccess: invalidate });
}

export function useRevokeOtherSessions() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: () => api.post<{ revoked: number }>('/api/security/sessions/revoke-others'), onSuccess: invalidate });
}

export function useForgetDevice() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: (id: number) => api.delete(`/api/security/devices/${encodeURIComponent(String(id))}`), onSuccess: invalidate });
}

export function useUpdateAllowlist() {
  const client = useQueryClient();
  const invalidate = useInvalidateSecurity();
  return useMutation({
    mutationFn: (entries: string[]) => api.put<IpAllowlist>('/api/security/ip-allowlist', { entries } satisfies IpAllowlistUpdate),
    onSuccess: (data) => {
      client.setQueryData(qk.security.allowlist, data);
      invalidate();
    },
  });
}

export function useChangePassword() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: (body: ChangePasswordRequest) => api.post('/api/security/password', body), onSuccess: invalidate });
}

export const useRegenerateTotp = () => useMutation({ mutationFn: () => api.post<TotpSetup>('/api/security/totp/regenerate') });

export function useConfirmTotp() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: (code: string) => api.post('/api/security/totp/confirm', { code }), onSuccess: invalidate });
}

export function useRegenerateBackupCodes() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: () => api.post<BackupCodes>('/api/security/backup-codes/regenerate'), onSuccess: invalidate });
}
