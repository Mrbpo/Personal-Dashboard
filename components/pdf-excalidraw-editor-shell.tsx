'use client';

import dynamic from 'next/dynamic';
import type {AnnotationScene} from '@/lib/pdf-annotation-scenes';

const Editor=dynamic(()=>import('./pdf-excalidraw-editor').then(module=>module.PdfExcalidrawEditor),{ssr:false,loading:()=> <p className="py-20 text-center">正在启动扩展绘图…</p>});

export function PdfExcalidrawEditorShell(props:{documentId:string;page:number;background:{dataURL:string;width:number;height:number};scene:AnnotationScene;revision:number;onSceneChange:(scene:AnnotationScene,revision:number)=>void;onClose:()=>void}){
  return <Editor {...props}/>;
}
