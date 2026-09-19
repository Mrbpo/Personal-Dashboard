import Link from 'next/link';
import {PageFrame} from '@/components/page-frame';
import {Button} from '@/components/ui/button';
import {getCurrentOwner} from '@/lib/authz';
import {previewDocument} from '@/lib/library';

export const dynamic='force-dynamic';

export default async function Page({params}:{params:Promise<{id:string}>}){
  const owner=await getCurrentOwner();
  if(!owner)return <PageFrame eyebrow="PRIVATE LIBRARY" title="请先登录" description="登录后才可预览私人资料。"><Button asChild><Link href="/login">前往登录</Link></Button></PageFrame>;
  const {id}=await params;
  let preview;
  try{preview=await previewDocument(owner.userId,id);}catch{return <PageFrame eyebrow="PRIVATE LIBRARY" title="无法打开资料" description="资料可能已被移除或暂时不可用。"><Button asChild variant="outline"><Link href="/library">返回资料库</Link></Button></PageFrame>;}
  const {document,text}=preview,source=`/api/library/${encodeURIComponent(id)}?preview=1`;
  return <PageFrame eyebrow="LIBRARY PREVIEW" title={document.name} description={`${document.course_id||'通用资料'} · ${document.size===0?0:Math.max(1,Math.round(document.size/1024))} KB`}>
    <div className="mb-4 flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/library">返回资料目录</Link></Button><Button asChild variant="outline"><a href={`/api/library/${encodeURIComponent(id)}`}>下载原件</a></Button></div>
    {document.mime==='application/pdf'?<iframe title={document.name} src={source} className="h-[78vh] w-full rounded-2xl border bg-white"/>:document.mime.startsWith('image/')?<div className="grid min-h-[55vh] place-items-center rounded-2xl border bg-black/5 p-4"><img src={source} alt={document.name} className="max-h-[78vh] max-w-full rounded-lg object-contain"/></div>:text?<article className="max-h-[78vh] overflow-auto rounded-2xl border bg-card p-5 md:p-7"><pre className="whitespace-pre-wrap break-words font-sans text-base leading-7">{text}</pre></article>:<div className="rounded-2xl border bg-card p-8 text-center text-muted-foreground">这份文件暂时没有可显示的预览正文，请稍后等待解析完成。</div>}
  </PageFrame>;
}
