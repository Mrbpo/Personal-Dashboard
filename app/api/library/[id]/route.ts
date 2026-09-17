import {apiOwner,apiError} from '@/lib/api-guard';
import {getDocument,readBlob,removeDocument} from '@/lib/library';
export async function GET(r:Request,{params}:{params:Promise<{id:string}>}){try{const d=await getDocument(await apiOwner(r),(await params).id);return new Response(await readBlob(d.hash),{headers:{'Content-Type':d.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}catch(e){return apiError(e);}}
export async function DELETE(r:Request,{params}:{params:Promise<{id:string}>}){try{await removeDocument(await apiOwner(r),(await params).id);return Response.json({ok:true});}catch(e){return apiError(e);}}
