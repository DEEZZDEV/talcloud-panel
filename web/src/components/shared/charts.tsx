import { useReducedMotion } from 'framer-motion';
import { useId, type ReactNode } from 'react';
import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Couleurs de séries : palette catégorielle validée (daltonisme, contraste) dans les deux thèmes.
 * La couleur suit l'entité, jamais son rang : le chiffre d'affaires est toujours bleu, les coûts orange, le bénéfice vert d'eau.
 */
export const SERIES_COLORS = {
  revenue: 'var(--chart-1)',
  costs: 'var(--chart-2)',
  profit: 'var(--chart-3)',
  neutral: 'var(--chart-4)',
  primary: 'var(--chart-1)',
} as const;

export interface ChartSeries<T> {
  key: Extract<keyof T, string>;
  label: string;
  color: string;
  type: 'area' | 'line' | 'bar';
}

interface TimeSeriesChartProps<T extends object> {
  data: T[];
  xKey: Extract<keyof T, string>;
  series: ChartSeries<T>[];
  /** Libellé court des graduations de l'axe X. */
  formatX: (value: string) => string;
  /** Libellé complet affiché dans l'infobulle. */
  formatXLong?: (value: string) => string;
  /** Valeur complète (infobulle, tableau). */
  formatValue: (value: number) => string;
  /** Valeur compacte (axe Y). */
  formatAxis?: (value: number) => string;
  height?: number;
  /** Domaine fixe de l'axe Y (ex. [0, 100] pour des pourcentages). */
  domain?: [number, number];
  /** Titre lu par les lecteurs d'écran. */
  ariaLabel: string;
  className?: string;
  allowDecimals?: boolean;
}

function ChartTooltip<T extends object>({
  active,
  payload,
  label,
  series,
  formatLabel,
  formatValue,
}: Pick<TooltipContentProps, 'active' | 'payload' | 'label'> & { series: ChartSeries<T>[]; formatLabel: (value: string) => string; formatValue: (value: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-[168px] rounded-lg border bg-popover px-3 py-2.5 text-popover-foreground shadow-pop">
      <p className="mb-2 text-xs font-medium capitalize text-muted-foreground">{formatLabel(String(label ?? ''))}</p>
      <ul className="flex flex-col gap-1.5">
        {series.map((item) => {
          const entry = payload.find((candidate) => candidate.dataKey === item.key);
          const value = typeof entry?.value === 'number' ? entry.value : null;
          return (
            <li key={item.key} className="flex items-center justify-between gap-5 text-[13px]">
              <span className="flex items-center gap-2 text-muted-foreground">
                <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                {item.label}
              </span>
              <span className="tabular font-semibold text-foreground">{value === null ? '—' : formatValue(value)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Légende : toujours présente dès deux séries ; la forme de la clé reprend celle de la marque. */
export function ChartLegend<T>({ series, className }: { series: ChartSeries<T>[]; className?: string }) {
  if (series.length < 2) return null;
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1', className)} aria-label="Légende">
      {series.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn('shrink-0', item.type === 'line' ? 'h-0.5 w-3 rounded-full' : 'size-2 rounded-[3px]')} style={{ backgroundColor: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Graphique temporel (aires, lignes, barres) sur un seul axe : grille et axes discrets, réticule + infobulle listant
 * toutes les séries, dégradés légers. Un tableau équivalent est fourni aux lecteurs d'écran.
 */
export function TimeSeriesChart<T extends object>({
  data,
  xKey,
  series,
  formatX,
  formatXLong,
  formatValue,
  formatAxis,
  height = 280,
  domain,
  ariaLabel,
  className,
  allowDecimals = true,
}: TimeSeriesChartProps<T>) {
  const gradientId = useId().replace(/:/g, '');
  const reducedMotion = useReducedMotion() ?? false;
  const animate = !reducedMotion;
  const hasBars = series.some((item) => item.type === 'bar');

  return (
    <figure className={cn('m-0', className)} aria-label={ariaLabel}>
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 600, height }}>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%" barGap={2} accessibilityLayer={false}>
            <defs>
              {series.map((item) => (
                <linearGradient key={item.key} id={`${gradientId}-${item.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={item.color} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={item.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} />
            <XAxis
              dataKey={xKey}
              tickFormatter={(value: string) => formatX(String(value))}
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              minTickGap={hasBars ? 4 : 18}
              interval="preserveStartEnd"
              padding={hasBars ? { left: 8, right: 8 } : { left: 4, right: 4 }}
              tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
            />
            <YAxis
              tickFormatter={(value: number) => (formatAxis ?? formatValue)(value)}
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              width={52}
              tickCount={5}
              domain={domain}
              allowDecimals={allowDecimals}
              tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
            />
            <Tooltip
              content={(props: TooltipContentProps) => (
                <ChartTooltip active={props.active} payload={props.payload} label={props.label} series={series} formatLabel={formatXLong ?? formatX} formatValue={formatValue} />
              )}
              cursor={hasBars ? { fill: 'hsl(var(--muted))', opacity: 0.6 } : { stroke: 'var(--chart-axis)', strokeWidth: 1, strokeOpacity: 0.5 }}
              isAnimationActive={false}
              offset={14}
              wrapperStyle={{ outline: 'none', zIndex: 10 }}
            />
            {series.map((item) => {
              if (item.type === 'bar') {
                return <Bar key={item.key} dataKey={item.key} name={item.label} fill={item.color} radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={animate} animationDuration={500} />;
              }
              if (item.type === 'area') {
                return (
                  <Area
                    key={item.key}
                    type="monotone"
                    dataKey={item.key}
                    name={item.label}
                    stroke={item.color}
                    strokeWidth={2}
                    fill={`url(#${gradientId}-${item.key})`}
                    dot={false}
                    activeDot={{ r: 4, fill: item.color, stroke: 'hsl(var(--card))', strokeWidth: 2 }}
                    connectNulls
                    isAnimationActive={animate}
                    animationDuration={600}
                  />
                );
              }
              return (
                <Line
                  key={item.key}
                  type="monotone"
                  dataKey={item.key}
                  name={item.label}
                  stroke={item.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  dot={false}
                  activeDot={{ r: 4, fill: item.color, stroke: 'hsl(var(--card))', strokeWidth: 2 }}
                  connectNulls
                  isAnimationActive={animate}
                  animationDuration={600}
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {/* Vue tableau : les mêmes valeurs, accessibles sans survol. */}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Période</th>
            {series.map((item) => (
              <th key={item.key} scope="col">
                {item.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => (
            <tr key={index}>
              <th scope="row">{(formatXLong ?? formatX)(String(row[xKey]))}</th>
              {series.map((item) => {
                const value = row[item.key];
                return <td key={item.key}>{typeof value === 'number' ? formatValue(value) : '—'}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Carte de graphique : titre, description, légende, actions. */
export function ChartCard({
  title,
  description,
  legend,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  legend?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {legend}
          {actions}
        </div>
      </CardHeader>
      <CardContent className="flex-1 pl-2 sm:pl-3">{children}</CardContent>
    </Card>
  );
}

export function ChartSkeleton({ height = 280 }: { height?: number }) {
  const bars = [38, 52, 44, 61, 55, 70, 64, 78, 72, 85, 80, 92];
  return (
    <div className="flex items-end gap-2 pl-3" style={{ height }} aria-hidden>
      {bars.map((value, index) => (
        <Skeleton key={index} className="flex-1 rounded-sm" style={{ height: `${value}%` }} />
      ))}
    </div>
  );
}
