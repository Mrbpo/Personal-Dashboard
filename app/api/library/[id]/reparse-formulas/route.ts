import {apiOwner,apiError} from '@/lib/api-guard';
import {getPdfFormulaReparseStatus,queuePdfFormulaReparse} from '@/lib/pdf-formula-reparse';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 try{return Response.json(await getPdfFormulaReparseStatus(await apiOwner(request),(await params).id),{headers:{'Cache-Control':'no-store'}});}
 catch(error){return apiError(error);}
}

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{return Response.json(await queuePdfFormulaReparse(await apiOwner(request),(await params).id),{headers:{'Cache-Control':'no-store'}});}
 catch(error){return apiError(error);}
}
