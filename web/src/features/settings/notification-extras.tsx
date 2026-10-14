import { BellRing, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TestResult } from '@/features/settings/integration-section';
import { currentPushSubscription, disablePush, enablePush, pushSupport, sendTestPush } from '@/features/notifications/push';
import { errorMessage, isStepUpCancelled } from '@/lib/api';
import { isRecord } from '@/lib/utils';
import type { SettingsTestResult } from '@shared/api-types';

interface Row {
  id: number;
  gateway: string;
  account: string;
}

const GATEWAY = /^[A-Za-z0-9_.\- ]{1,64}$/;

/** Correspondance « passerelle WHMCS → compte qui encaisse », affichée dans chaque notification de paiement. */
export function GatewayAccountsEditor({ stored, onChange }: { stored: unknown; onChange: (value: Record<string, string>) => void }) {
  const [rows, setRows] = useState<Row[]>(() =>
    isRecord(stored)
      ? Object.entries(stored)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([gateway, account], index) => ({ id: index, gateway, account }))
      : [],
  );
  const [nextId, setNextId] = useState(1000);

  const commit = (next: Row[]) => {
    setRows(next);
    const record: Record<string, string> = {};
    for (const row of next) {
      const gateway = row.gateway.trim();
      const account = row.account.trim();
      if (gateway && account && GATEWAY.test(gateway)) record[gateway] = account;
    }
    onChange(record);
  };

  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4">
      <legend className="px-1 text-[13px] font-medium">Compte qui encaisse, par passerelle</legend>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Associez chaque passerelle de paiement WHMCS (identifiant technique, ex. <code className="rounded bg-muted px-1 font-mono">stripe</code>, <code className="rounded bg-muted px-1 font-mono">paypal</code>,{' '}
        <code className="rounded bg-muted px-1 font-mono">banktransfer</code>) au compte qui reçoit l'argent. Ce libellé apparaît dans les notifications de paiement.
      </p>
      {rows.length === 0 ? <p className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">Aucune correspondance pour l'instant.</p> : null}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const invalid = row.gateway.trim() !== '' && !GATEWAY.test(row.gateway.trim());
          return (
            <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-start gap-2">
              <Input
                value={row.gateway}
                onChange={(event) => commit(rows.map((item) => (item.id === row.id ? { ...item, gateway: event.target.value } : item)))}
                placeholder="stripe"
                maxLength={64}
                aria-label="Identifiant de la passerelle"
                aria-invalid={invalid || undefined}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              <Input
                value={row.account}
                onChange={(event) => commit(rows.map((item) => (item.id === row.id ? { ...item, account: event.target.value } : item)))}
                placeholder="Stripe — TalCloud SAS"
                maxLength={120}
                aria-label="Compte qui encaisse"
                autoComplete="off"
              />
              <Button variant="ghost" size="icon" onClick={() => commit(rows.filter((item) => item.id !== row.id))} aria-label={`Retirer la passerelle ${row.gateway || 'vide'}`}>
                <Trash2 aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={rows.length >= 50}
        onClick={() => {
          setRows([...rows, { id: nextId, gateway: '', account: '' }]);
          setNextId(nextId + 1);
        }}
      >
        <Plus aria-hidden />
        Ajouter une passerelle
      </Button>
    </fieldset>
  );
}

/** Notifications push du navigateur (par appareil) : activation, désactivation et envoi d'essai. */
export function PushSettings() {
  const support = pushSupport();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'test' | null>(null);
  const [result, setResult] = useState<SettingsTestResult | null>(null);
  const denied = support === 'supported' && Notification.permission === 'denied';

  useEffect(() => {
    let cancelled = false;
    currentPushSubscription()
      .then((subscription) => {
        if (!cancelled) setSubscribed(subscription !== null);
      })
      .catch(() => {
        if (!cancelled) setSubscribed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async () => {
    setBusy('toggle');
    setResult(null);
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
        toast.success('Notifications push désactivées sur cet appareil');
      } else {
        await enablePush();
        setSubscribed(true);
        toast.success('Notifications push activées sur cet appareil');
      }
    } catch (error) {
      // Code 2FA demandé puis annulé : rien n'a changé, pas de message d'erreur.
      if (isStepUpCancelled(error)) return;
      toast.error(subscribed ? 'Désactivation impossible' : 'Activation impossible', { description: error instanceof Error && error.name !== 'ApiError' ? error.message : errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      setResult(await sendTestPush());
    } catch (error) {
      setResult({ ok: false, message: errorMessage(error, "L'envoi d'essai a échoué.") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4" aria-labelledby="push-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id="push-title" className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
            <BellRing className="size-4 text-subtle" aria-hidden />
            Notifications push sur cet appareil
            {subscribed === null || support !== 'supported' ? null : subscribed ? <Badge tone="success">Activées</Badge> : <Badge>Désactivées</Badge>}
          </h3>
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
            Recevez les commandes et paiements même quand le panel est fermé. Le réglage est propre à chaque navigateur : activez-le aussi sur votre téléphone (sur iPhone, ajoutez d'abord le panel à l'écran
            d'accueil).
          </p>
        </div>
        {support === 'supported' ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={subscribed ? 'outline' : 'default'} size="sm" onClick={() => void toggle()} loading={busy === 'toggle'} disabled={subscribed === null || denied || busy === 'test'}>
              {subscribed ? 'Désactiver' : 'Activer'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void test()} loading={busy === 'test'} disabled={!subscribed || busy === 'toggle'}>
              Envoyer un essai
            </Button>
          </div>
        ) : null}
      </div>
      {support === 'insecure' ? <p className="text-xs text-warning">Les notifications push exigent une connexion HTTPS.</p> : null}
      {support === 'unsupported' ? <p className="text-xs text-warning">Ce navigateur ne prend pas en charge les notifications push.</p> : null}
      {denied ? <p className="text-xs text-warning">Les notifications sont bloquées pour ce site : autorisez-les dans les réglages du navigateur, puis rechargez la page.</p> : null}
      <TestResult result={result} />
    </section>
  );
}
