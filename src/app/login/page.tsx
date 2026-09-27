import { Suspense } from 'react';
import LoginForm from './LoginForm';

export const metadata = { title: 'Sign in' };

export default function LoginPage() {
  // Read server-side: the flag must not be exposed to the client bundle, and
  // AUTH_DEMO_MODE is intentionally not a NEXT_PUBLIC_ variable.
  const demoMode = process.env.AUTH_DEMO_MODE === 'true';

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-12">
      {/* useSearchParams needs a Suspense boundary during prerender. */}
      <Suspense fallback={<div className="w-full max-w-sm" />}>
        <LoginForm demoMode={demoMode} />
      </Suspense>
    </main>
  );
}
