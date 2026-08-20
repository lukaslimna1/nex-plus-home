import { redirect } from 'next/navigation';
import { getCurrentAppUser } from '@/auth/current-user';
import { HomeClient } from './HomeClient';

export default async function HomePage() {
  const user = await getCurrentAppUser();

  if (!user) {
    redirect('/login');
  }

  return <HomeClient user={user} />;
}
