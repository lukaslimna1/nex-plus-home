import { redirect } from 'next/navigation';
import { getCurrentAppUser } from '@/auth/current-user';
import { HomeClient } from './HomeClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  const user = await getCurrentAppUser();

  if (!user) {
    redirect('/login');
  }

  return <HomeClient user={user} />;
}
