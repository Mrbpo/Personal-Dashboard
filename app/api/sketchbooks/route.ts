import { apiOwner, apiError } from '@/lib/api-guard';
import { sketchState, addSketchPage, saveSketchPage, clearSketchPage, restoreClearedSketchPage, saveSketchDraft, saveSketchNoteDraft, commitSketchNote, addSketchText, touchSketch, editSketchEntry, deleteSketchEntry, askSketch, generateSketchPdf, sketchPdf, sketchImage, sketchBaseImage } from '@/lib/sketchbooks';
export const runtime='nodejs';
const noStore={'Cache-Control':'private, no-store'};
export async function GET(request:Request){
  try{
    const owner=await apiOwner(request),query=new URL(request.url).searchParams,bookId=query.get('book')||undefined;
    if(query.has('image')){if(!bookId)throw new Error('画册不存在');const bytes=await sketchImage(owner,bookId,Number(query.get('image')));return new Response(new Uint8Array(bytes),{headers:{...noStore,'Content-Type':'image/png'}});}
    if(query.has('base')){if(!bookId)throw new Error('画册不存在');const bytes=await sketchBaseImage(owner,bookId,Number(query.get('base')));return new Response(new Uint8Array(bytes),{headers:{...noStore,'Content-Type':'image/png'}});}
    if(query.has('pdf')){if(!bookId)throw new Error('画册不存在');const bytes=await sketchPdf(owner,bookId,String(query.get('pdf')));return new Response(new Uint8Array(bytes),{headers:{...noStore,'Content-Type':'application/pdf','Content-Disposition':'inline; filename="sketchbook.pdf"'}});}
    return Response.json(await sketchState(owner,bookId),{headers:noStore});
  }catch(e){return apiError(e);}
}
export async function POST(request:Request){
  try{
    const owner=await apiOwner(request);
    if(Number(request.headers.get('content-length')||0)>12*1024*1024)throw new Error('请求超过 12 MB');
    const body=await request.json(),bookId=String(body.bookId||''),action=String(body.action||'');
    if(action==='page')return Response.json({pageNo:await addSketchPage(owner,bookId)});
    if(action==='savePage')return Response.json(await saveSketchPage(owner,bookId,Number(body.pageNo),String(body.image||''),Number(body.revision),body.strokes));
    if(action==='clearPage')return Response.json(await clearSketchPage(owner,bookId,Number(body.pageNo),Number(body.revision)));
    if(action==='restorePage')return Response.json(await restoreClearedSketchPage(owner,bookId,Number(body.pageNo),Number(body.revision)));
    if(action==='draft'){await saveSketchDraft(owner,bookId,String(body.text||''),String(body.expected||''));return Response.json({ok:true});}
    if(action==='touch'){await touchSketch(owner,bookId);return Response.json({ok:true});}
    if(action==='noteDraft')return Response.json(await saveSketchNoteDraft(owner,bookId,Number(body.pageNo),String(body.text||''),Number(body.revision)));
    if(action==='text')return Response.json(body.entryId?await commitSketchNote(owner,bookId,Number(body.pageNo),String(body.body||''),Number(body.revision),String(body.entryId)): {id:await addSketchText(owner,bookId,Number(body.pageNo),String(body.body||''))});
    if(action==='edit')return Response.json(await editSketchEntry(owner,bookId,String(body.entryId||''),String(body.body||''),Number(body.revision)));
    if(action==='delete'){await deleteSketchEntry(owner,bookId,String(body.entryId||''));return Response.json({ok:true});}
    if(action==='ask'){await askSketch(owner,bookId,Number(body.pageNo),String(body.requestId||''));return Response.json(await sketchState(owner,bookId));}
    if(action==='pdf')return Response.json({versionId:await generateSketchPdf(owner,bookId)});
    throw new Error('操作无效');
  }catch(e){return apiError(e);}
}
