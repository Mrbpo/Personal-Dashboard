import {apiOwner,apiError} from '@/lib/api-guard';
import {getPageAnnotations,putPageAnnotations,MAX_ANNOTATION_BYTES} from '@/lib/pdf-annotations';

function pageFrom(request:Request){return Number(new URL(request.url).searchParams.get('page'));}

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const owner=await apiOwner(request),{id}=await params;
    return Response.json(await getPageAnnotations(owner,id,pageFrom(request)),{headers:{'Cache-Control':'no-store'}});
  }catch(error){return apiError(error);}
}

export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    const owner=await apiOwner(request),{id}=await params;
    const length=Number(request.headers.get('content-length')||0);
    if(length>MAX_ANNOTATION_BYTES+1024)throw new Error('批注数据超出限制');
    const reader=request.body?.getReader();
    if(!reader)throw new Error('请求为空');
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_ANNOTATION_BYTES+1024){await reader.cancel();throw new Error('批注数据超出限制');}chunks.push(value);}
    const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const saved=await putPageAnnotations(owner,id,pageFrom(request),payload?.revision,payload?.strokes);
    if(!saved)return Response.json({error:'另一窗口已修改此页批注，请刷新后重试'}, {status:409});
    return Response.json(saved,{headers:{'Cache-Control':'no-store'}});
  }catch(error){return apiError(error);}
}
