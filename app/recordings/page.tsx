import Link from 'next/link';
import {PageFrame} from '@/components/page-frame';
import {RecordingPlayer} from '@/components/recording-player';
import {RecordingSyncControl} from '@/components/recording-sync-control';
import {requireOwnerPage} from '@/lib/authz';

export const dynamic='force-dynamic';

export default async function Page() {
  const {authorized}=await requireOwnerPage('/recordings');
  return <PageFrame eyebrow="COURSE RECORDINGS" title="课程录像">
    {authorized?<><RecordingSyncControl/><RecordingPlayer/></>:<Link href="/login">请先登录</Link>}
  </PageFrame>;
}
