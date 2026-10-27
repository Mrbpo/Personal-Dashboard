import Link from 'next/link';
import {PageFrame} from '@/components/page-frame';
import {Button} from '@/components/ui/button';
import {PdfReaderShell} from '@/components/pdf-reader-shell';
import {getCurrentOwner} from '@/lib/authz';
import {previewDocument} from '@/lib/library';
import {MiniAiFeedback} from '@/components/mini-ai-feedback';
import {PdfFormulaReparse} from '@/components/pdf-formula-reparse';
import {getPdfFormulaReparseStatus} from '@/lib/pdf-formula-reparse';
import {LibraryStudyPanel} from '@/components/library-study-panel';
import {studyAnswerBackend} from '@/lib/study-answer';

export const dynamic='force-dynamic';

export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{page?:string|string[]}>}){
  const owner=await getCurrentOwner();
  if(!owner)return <PageFrame eyebrow="PRIVATE LIBRARY" title="请先登录" description="登录后才可预览私人资料。"><Button asChild><Link href="/login">前往登录</Link></Button></PageFrame>;
  const {id}=await params;
  const requestedPage=(await searchParams).page;
  const initialPage=typeof requestedPage==='string'&&/^[1-9]\d*$/.test(requestedPage)&&Number.isSafeInteger(Number(requestedPage))?Number(requestedPage):1;
  let preview;
  try{preview=await previewDocument(owner.userId,id);}catch{return <PageFrame eyebrow="PRIVATE LIBRARY" title="无法打开资料" description="资料可能已被移除或暂时不可用。"><Button asChild variant="outline"><Link href="/library">返回资料库</Link></Button></PageFrame>;}
  const {document,text,pages}=preview,source=`/api/library/${encodeURIComponent(id)}?preview=1`,formulaStatus=document.mime==='application/pdf'?await getPdfFormulaReparseStatus(owner.userId,id):null;
  return <PageFrame eyebrow="LIBRARY PREVIEW" title={document.name} description={`${document.course_id||'通用资料'} · ${document.folder_path||'根目录'} · ${document.size===0?0:Math.max(1,Math.round(document.size/1024))} KB`}>
    <div className="mb-4 flex flex-wrap gap-2"><Button asChild variant="outline"><Link href="/library">返回资料目录</Link></Button><Button asChild variant="outline"><a href={`/api/library/${encodeURIComponent(id)}`}>下载原件</a></Button></div>
    {document.mime==='application/pdf'?<>
      <PdfReaderShell source={source} name={document.name} documentId={document.id} initialPage={initialPage}/>
      {process.env.STUDY_FACTS_ONLY!=='true'&&studyAnswerBackend()==='kernel'&&<div className="mt-6"><LibraryStudyPanel initialDocumentIds={[document.id]} embedded/></div>}
      <section className="mt-8 overflow-hidden rounded-2xl border bg-card" id="text-version">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4"><div><p className="text-xs font-semibold uppercase tracking-[.14em] text-muted-foreground">TEXT VERSION</p><h2 className="mt-1 text-xl font-semibold">PDF 文字版本</h2></div><span className="text-sm text-muted-foreground">{pages.length?`${pages.length} 页已转换`:document.status==='error'?'正在重新尝试转换':'正在转换'}</span></div>
        {formulaStatus&&<PdfFormulaReparse documentId={id} initialStatus={formulaStatus}/>}
        {pages.length?<div className="max-h-[75vh] overflow-auto px-5 md:px-7">{pages.map(item=><article key={item.page} className="border-b py-6 last:border-b-0"><h3 className="mb-3 font-semibold text-primary">{item.locator}</h3><pre className="whitespace-pre-wrap break-words font-sans text-base leading-7">{item.text}</pre></article>)}</div>:<div className="p-8 text-center text-muted-foreground"><p>后台正在逐页转换文字，扫描页会自动识别。</p><p className="mt-2 text-sm">稍后刷新本页即可看到文字版本；已完成的页面会保留并从中断处继续。</p></div>}
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">文字可直接选择和复制；识别出的公式以 LaTeX 显示。复杂公式、表格与图形请核对上方 PDF 原页。</p>
        {pages.length>0&&<div className="px-5 pb-4"><MiniAiFeedback sourceType="library-extraction" sourceId={document.id} metadata={{parser:'pdf-text'}}/></div>}
      </section>
    </>:document.mime.startsWith('image/')?<div className="grid min-h-[55vh] place-items-center rounded-2xl border bg-black/5 p-4"><img src={source} alt={document.name} className="max-h-[78vh] max-w-full rounded-lg object-contain"/></div>:text?<article className="max-h-[78vh] overflow-auto rounded-2xl border bg-card p-5 md:p-7"><pre className="whitespace-pre-wrap break-words font-sans text-base leading-7">{text}</pre></article>:<div className="rounded-2xl border bg-card p-8 text-center text-muted-foreground">这份文件暂时没有可显示的预览正文，请稍后等待解析完成。</div>}
  </PageFrame>;
}
