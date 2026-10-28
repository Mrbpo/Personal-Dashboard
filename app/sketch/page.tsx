import { PageFrame } from '@/components/page-frame';
import { SketchWorkspace } from '@/components/sketch-workspace';
import { requireOwnerPage } from '@/lib/authz';
export const dynamic='force-dynamic';
export default async function Page(){const {authorized}=await requireOwnerPage('/sketch');return <PageFrame eyebrow="DRAW & ASK" title="绘画问 AI">{authorized?<SketchWorkspace/>:<a href="/login">请先登录</a>}</PageFrame>;}
