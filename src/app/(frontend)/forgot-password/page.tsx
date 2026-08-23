import { redirect } from 'next/navigation';
import { getCurrentAppUser } from '@/auth/current-user';
import { ForgotPasswordForm } from './ForgotPasswordForm';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Recuperar Senha · NEX+',
  description: 'Recupere o acesso à sua conta no NEX+.',
};

export default async function ForgotPasswordPage() {
  const user = await getCurrentAppUser();

  if (user) {
    redirect('/home');
  }

  return <ForgotPasswordForm />;
}
