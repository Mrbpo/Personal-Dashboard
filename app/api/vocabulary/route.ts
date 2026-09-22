import {apiOwner,apiError} from '@/lib/api-guard';
import {defineVocabulary,deleteVocabularyEntry,generateVocabularyExamples,listVocabularyEntries,saveVocabularyEntry} from '@/lib/vocabulary';

export async function GET(request:Request){try{return Response.json({entries:await listVocabularyEntries(await apiOwner(request))},{headers:{'Cache-Control':'no-store'}});}catch(error){return apiError(error);}}
export async function POST(request:Request){try{const owner=await apiOwner(request),body=await request.json();if(body.action==='examples')return Response.json({entry:await generateVocabularyExamples(owner,String(body.id||''))});if(body.action==='define')return Response.json({entry:await defineVocabulary(owner,String(body.id||''))});return Response.json({entry:await saveVocabularyEntry(owner,{term:String(body.term||''),background:String(body.background||''),courseId:String(body.courseId||'')})});}catch(error){return apiError(error);}}
export async function DELETE(request:Request){try{return Response.json(await deleteVocabularyEntry(await apiOwner(request),String((await request.json()).id||'')));}catch(error){return apiError(error);}}
