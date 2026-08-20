import { redirect } from 'next/navigation';
import { getCurrentAppUser } from '@/auth/current-user';
import { LoginForm } from './LoginForm';

export default async function LoginPage() {
  const user = await getCurrentAppUser();

  if (user) {
    redirect('/home');
  }

  return <LoginForm />;
}
