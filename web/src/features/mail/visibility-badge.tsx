import type { MailAccount } from '@shared/api-types';
import { Lock, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/** Badge « Partagée » (visible par les deux administrateurs) / « Personnelle » (visible uniquement par son propriétaire). */
export function VisibilityBadge({ account, className }: { account: Pick<MailAccount, 'visibility'>; className?: string }) {
  return account.visibility === 'personal' ? (
    <Badge tone="primary" className={className} title="Visible uniquement par moi">
      <Lock className="size-3" aria-hidden />
      Personnelle
    </Badge>
  ) : (
    <Badge className={className} title="Visible par les deux administrateurs">
      <Users className="size-3" aria-hidden />
      Partagée
    </Badge>
  );
}

/** Boîtes regroupées pour les sélecteurs : les miennes (personnelles) d'abord, puis les partagées. */
export function groupAccounts(accounts: MailAccount[]): { mine: MailAccount[]; shared: MailAccount[] } {
  return {
    mine: accounts.filter((account) => account.visibility === 'personal' && account.ownedByMe),
    shared: accounts.filter((account) => account.visibility === 'shared'),
  };
}
