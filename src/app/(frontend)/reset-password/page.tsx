import { redirect } from 'next/navigation';
import { getCurrentAppUser } from '@/auth/current-user';
import { ResetPasswordForm } from './ResetPasswordForm';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Nova Senha · NEX+',
  description: 'Crie uma nova senha para sua conta no NEX+.',
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const user = await getCurrentAppUser();

  if (user) {
    redirect('/home');
  }

  const resolvedParams = await searchParams;
  const token =
    typeof resolvedParams.token === 'string'
      ? resolvedParams.token
      : Array.isArray(resolvedParams.token)
      ? resolvedParams.token[0]
      : undefined;

  return <ResetPasswordForm token={token} />;
}
