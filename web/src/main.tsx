import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './index.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'framer-motion';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from '@/App';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/features/auth/auth-context';
import { queryClient } from '@/lib/query';

const container = document.getElementById('root');
if (!container) throw new Error('Élément #root introuvable');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary fullScreen>
      {/* `reducedMotion="user"` : les animations respectent « prefers-reduced-motion ». */}
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={250} skipDelayDuration={150}>
            <BrowserRouter>
              <AuthProvider>
                <App />
              </AuthProvider>
            </BrowserRouter>
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </MotionConfig>
    </ErrorBoundary>
  </StrictMode>,
);
