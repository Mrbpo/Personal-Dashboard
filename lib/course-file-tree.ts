export type FileNode = {
  id: string; name: string; kind: 'course'|'folder'|'lecture'|'file';
  children?: FileNode[]; childrenUrl?: string; downloadUrl?: string;
  bytes?: number; storage?: 'server'|'r2'|'r2-archive'; publishedAt?: number|null;
};
export type TreeResponse = {entries:FileNode[]; warning?:string};
export type TreeDocument = {id:string; name:string; original_name?:string|null; folder_path:string; size:number};
export const filesApi = '/api/v1/files';

export function documentFolders(documents:TreeDocument[]):FileNode[] {
  const root:FileNode[] = [];
  const folders = new Map<string,FileNode>();
  for (const document of documents) {
    let nodes = root, path = '';
    for (const part of document.folder_path.split('/').filter(Boolean)) {
      path += '/'+part;
      let folder = folders.get(path);
      if (!folder) {
        folder = {id:'folder:'+path,name:part,kind:'folder',children:[]};
        folders.set(path,folder);
        nodes.push(folder);
      }
      nodes = folder.children!;
    }
    nodes.push({id:'doc:'+document.id,name:document.original_name||document.name,kind:'file',
      bytes:document.size,storage:'server',downloadUrl:filesApi+'?document='+encodeURIComponent(document.id)});
  }
  const sort = (nodes:FileNode[]) => {
    nodes.sort((a,b)=>Number(b.kind==='folder')-Number(a.kind==='folder')||a.name.localeCompare(b.name,'zh')||a.id.localeCompare(b.id));
    for(const node of nodes) if(node.children) sort(node.children);
  };
  sort(root);
  return root;
}
