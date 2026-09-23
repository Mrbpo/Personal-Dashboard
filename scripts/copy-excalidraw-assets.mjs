import {cp,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

const source=join(process.cwd(),'node_modules','@excalidraw','excalidraw','dist','prod','fonts');
const destination=join(process.cwd(),'public','excalidraw-assets','fonts');
await mkdir(destination,{recursive:true});
await cp(source,destination,{recursive:true,force:true});
console.log('Excalidraw fonts copied for local serving.');
