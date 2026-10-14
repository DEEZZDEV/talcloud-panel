import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useTheme } from '@/hooks/use-theme';

/** Toasts du panel, alignés sur les jetons de couleur (deux thèmes). */
function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      gap={10}
      visibleToasts={4}
      closeButton
      icons={{
        success: <CircleCheck className="size-4 text-success" aria-hidden />,
        info: <Info className="size-4 text-info" aria-hidden />,
        warning: <TriangleAlert className="size-4 text-warning" aria-hidden />,
        error: <CircleAlert className="size-4 text-danger" aria-hidden />,
        loading: <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />,
      }}
      toastOptions={{
        classNames: {
          toast: '!rounded-xl !border !border-border !bg-popover !text-popover-foreground !shadow-pop !font-sans !text-[13px] !gap-3',
          title: '!font-medium',
          description: '!text-muted-foreground !text-[13px]',
          actionButton: '!bg-primary !text-primary-foreground !rounded-md !font-medium',
          cancelButton: '!bg-muted !text-muted-foreground !rounded-md',
          closeButton: '!border-border !bg-popover !text-muted-foreground',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
