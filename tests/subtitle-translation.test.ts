import test from 'node:test';
import assert from 'node:assert/strict';
import {subtitleTranslationSchema,parseSubtitleTranslations} from '../lib/subtitle-translation.ts';

test('generation requires every exact cue key and nonblank text, including sparse resumed indices',()=>{
 const schema=subtitleTranslationSchema([60,62,119]);
 assert.deepEqual(schema.properties.translations.required,['60','62','119']);
 assert.equal(schema.properties.translations.additionalProperties,false);
 assert.equal(schema.properties.translations.properties['60'].pattern,'\\S');
 assert.deepEqual(parseSubtitleTranslations({translations:{119:'最后',60:'第一',62:'第二'}},[60,62,119]),[{index:60,zh:'第一'},{index:62,zh:'第二'},{index:119,zh:'最后'}]);
});

test('omission, extra identity, blank text and legacy array cannot silently become complete',()=>{
 for(const translations of [{0:'一'}, {0:'一',1:'二',2:'三'}, {0:'一',1:'  '}, [{index:0,zh:'一'},{index:1,zh:'二'}]]){
  assert.throws(()=>parseSubtitleTranslations({translations},[0,1]),/Incomplete/);
 }
 assert.throws(()=>subtitleTranslationSchema([0,0]),/Invalid/);
});
