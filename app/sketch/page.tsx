import { PageFrame } from '@/components/page-frame';
import { SketchWorkspace } from '@/components/sketch-workspace';
import { requireOwnerPage } from '@/lib/authz';
export const dynamic='force-dynamic';
export default async function Page(){const {authorized}=await requireOwnerPage('/sketch');return <PageFrame eyebrow="DRAW & ASK" title="绘画问 AI" description="把手写、图形和公式留在画册里，只将当前页与问题发给学习导师。">{authorized?<SketchWorkspace/>:<a href="/login">请先登录</a>}</PageFrame>;}
