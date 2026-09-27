import SignupForm from './SignupForm';

export const metadata = { title: 'Create account' };

export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-primary-900 px-4">
      <SignupForm />
    </main>
  );
}
