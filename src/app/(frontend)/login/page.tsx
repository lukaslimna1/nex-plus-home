import { redirect } from 'next/navigation';
import { getCurrentAppUser } from '@/auth/current-user';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function LoginPage() {
  const user = await getCurrentAppUser();

  if (user) {
    redirect('/home');
  }

  return <LoginForm />;
}
