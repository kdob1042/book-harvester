import {test} from 'node:test';
import assert from 'node:assert/strict';
import {questionTree} from '../public/question-tree.js';

test('shared branches expand once and cycles terminate', () => {
 const themes = ['a','b','shared','leaf'].map(id => ({id,question:id,is_tip:['a','b'].includes(id)?1:0}));
 const branches = [['a','shared'],['b','shared'],['shared','leaf'],['leaf','shared']]
  .map(([parent_id,child_id]) => ({parent_id,child_id}));
 const html = questionTree({themes,branches}, String);
 assert.equal((html.match(/data-theme="leaf"/g)||[]).length, 1);
 assert.ok(html.includes('data-theme="a"') && html.includes('data-theme="b"'));
 assert.ok(html.length < 2000);
});

test('deep question history does not overflow the stack', () => {
 const themes = Array.from({length:12000},(_,i) => ({id:String(i),question:String(i),is_tip:i===0?1:0}));
 const branches = themes.slice(1).map((t,i) => ({parent_id:String(i),child_id:t.id}));
 const html = questionTree({themes,branches}, String);
 assert.equal((html.match(/data-theme=/g)||[]).length, themes.length);
});
