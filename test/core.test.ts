import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository, WEEK } from '../src/db.ts';
import { Pipeline } from '../src/pipeline.ts';
import { ProviderError } from '../src/types.ts';
import type { Question, Play, ImageStore } from '../src/types.ts';
function fixture(budget = 10000) {
  let time = Date.UTC(2026, 9, 12, 12);
  const dir = mkdtempSync(join(tmpdir(), 'slop-test-'));
  const repo = new Repository(join(dir, 'test.sqlite'), budget, () => time);
  const close = () => { repo.db.close(); rmSync(dir, {recursive:true, force:true}); };
  const store: ImageStore & { files: Map<string, Buffer> } = { files: new Map(), async put(k,b) {this.files.set(k,b);}, async get(k) {const b = this.files.get(k); if(!b) throw new Error('not found'); return b;}, async delete(k) {this.files.delete(k);} };
  return {repo,store,dir,close,advance:(ms:number) => {time += ms;}};
}
function ready(repo: Repository, count = 2) {
  const game = repo.create('Test game');
  for(let i=0;i<count;i++) { const q = repo.acceptUpload(game.id); q.state = 'ready'; repo.save('questions',q); }
  return repo.publish(game.id);
}
test('correct scoring, duplicate answers and Next, refresh and replay', () => {
  const f = fixture(); try {
    const game = ready(f.repo), first = f.repo.start(game.invite!);
    let p = f.repo.play(first.id); const originalPositions = p.questions.map(q => q.ai), q = p.questions[0];
    assert.equal('ai' in first.question!, false);
    assert.equal(f.repo.answer(p.id,q.id,q.ai).score,1);
    assert.equal(f.repo.answer(p.id,q.id,1-q.ai).score,1);
    f.repo.next(p.id,q.id); f.repo.next(p.id,q.id); assert.equal(f.repo.play(p.id).current,1);
    const second = f.repo.play(p.id).questions[1]; f.repo.answer(p.id,second.id,1-second.ai); const final = f.repo.next(p.id,second.id);
    assert.equal(final.score,1); assert.equal(final.total,2); assert.equal(final.question,null);
    const replay = f.repo.start(game.invite!); assert.notEqual(first.id,replay.id); assert.equal(replay.score,0); assert.equal(replay.current,0); assert.equal(replay.question!.chosen,null);
    assert.deepEqual(f.repo.play(first.id).questions.map(q=>q.ai),originalPositions);
    assert.throws(() => f.repo.acceptUpload(game.id), /cannot be edited/);
  } finally {f.close();}
});
test('state and positions survive database reopening', () => {
  const f = fixture(); try {
    const game = ready(f.repo), start = f.repo.start(game.invite!), p = f.repo.play(start.id);
    f.repo.answer(p.id,p.questions[0].id,p.questions[0].ai);
    const db2 = new Repository(join(f.dir,'test.sqlite'),10000,f.repo.now);
    try { assert.deepEqual(db2.play(p.id),f.repo.play(p.id)); } finally {db2.db.close();}
  } finally {f.close();}
});
test('playthrough randomization is independent and never derived from previous positions', () => {
  const f = fixture(); try {
    const game = ready(f.repo), sequences = new Set<string>();
    for(let i=0;i<100;i++) { const p = f.repo.start(game.invite!); sequences.add(f.repo.play(p.id).questions.map(q=>q.ai).join('')); }
    assert.equal(sequences.size,4);
  } finally {f.close();}
});
test('two database connections cannot exceed reservation capacity', () => {
  const f = fixture(2080), other = new Repository(join(f.dir,'test.sqlite'),2080,f.repo.now);
  try {
    const g = f.repo.create('Budget'); f.repo.acceptUpload(g.id); other.acceptUpload(g.id);
    assert.throws(() => f.repo.acceptUpload(g.id), /budget exhausted/); assert.equal(other.budget().reserved,2080);
    assert.equal(f.repo.list('questions',g.id).length,2);
    f.advance(86400000); assert.equal(f.repo.budget().reserved,0);
  } finally {other.db.close();f.close();}
});
test('question limit and publish readiness', () => {
  const f = fixture(100000); try {
    const g = f.repo.create('Draft'); assert.throws(() => f.repo.publish(g.id), /must be ready/);
    for(let i=0;i<10;i++) f.repo.acceptUpload(g.id);
    assert.throws(() => f.repo.acceptUpload(g.id), /up to 10/); assert.throws(() => f.repo.publish(g.id), /must be ready/);
  } finally {f.close();}
});
test('temporary failures retry three times, manual retry resumes generator', async () => {
  const f = fixture(); try {
    const game = f.repo.create('Pipeline'), q = f.repo.acceptUpload(game.id); q.state='describe'; f.repo.save('questions',q); await f.store.put(q.original,Buffer.from('original'));
    let describes=0,generates=0,fail=true;
    const descriptor = {model:'descriptor-v1',async describe(b:Buffer){assert.equal(b.toString(),'original');describes++;return 'A photo of a cat.';}};
    const generator = {model:'generator-v1',async generate(text:string){assert.equal(text,'A photo of a cat.');generates++;if(fail) throw new ProviderError('Busy',true); return Buffer.from('generated');}};
    const pipeline = new Pipeline(f.repo,f.store,descriptor,generator,async b=>b);
    await pipeline.tick(); assert.equal(describes,1);
    for(let i=0;i<4;i++) {await pipeline.tick();f.advance(20000);}
    assert.equal(generates,4);assert.equal(f.repo.get<Question>('questions',q.id)!.state,'failed');
    fail=false;f.repo.retry(q.id);await pipeline.tick();assert.equal(describes,1);assert.equal(generates,5);
    const done=f.repo.get<Question>('questions',q.id)!; assert.equal(done.state,'ready');assert.equal(done.descriptorModel,'descriptor-v1');assert.equal(done.generatorModel,'generator-v1');
  } finally {f.close();}
});
test('permanent failures do not auto retry, manual retries are bounded', async () => {
  const f = fixture();try {
    const g=f.repo.create('Failure'),q=f.repo.acceptUpload(g.id);q.state='describe';f.repo.save('questions',q);await f.store.put(q.original,Buffer.from('original'));
    const pipe=new Pipeline(f.repo,f.store,{model:'d',async describe(){throw new ProviderError('Access denied',false);}},{model:'g',async generate(){throw new Error();}},async b=>b);
    await pipe.tick(); assert.equal(f.repo.get<Question>('questions',q.id)!.state,'failed');assert.equal(await pipe.tick(),false);
    for(let i=0;i<2;i++){f.repo.retry(q.id);await pipe.tick();} assert.throws(()=>f.repo.retry(q.id),/Retry limit/);
  }finally{f.close();}
});
test('durable job lease prevents double claim and resumes after restart', async () => {
  const f=fixture();try {
    const g=f.repo.create('Lease'),q=f.repo.acceptUpload(g.id);q.state='describe';f.repo.save('questions',q);await f.store.put(q.original,Buffer.from('x'));
    const pipe=new Pipeline(f.repo,f.store,{model:'d',async describe(){return 'Saved description';}},{model:'g',async generate(){return Buffer.from('y');}},async b=>b);
    assert.ok(pipe.claim()); assert.equal(pipe.claim(),undefined); f.advance(300001);assert.equal(await pipe.tick(),true);assert.equal(f.repo.get<Question>('questions',q.id)!.state,'generate');
  }finally{f.close();}
});
test('expiration blocks plays and images and schedules deletion for drafts and games', async () => {
  const f=fixture();try {
    const g=ready(f.repo),start=f.repo.start(g.invite!),draft=f.repo.create('Old draft');
    const q=f.repo.acceptUpload(draft.id);await f.store.put(q.original,Buffer.from('original'));
    f.advance(WEEK);assert.throws(()=>f.repo.invite(g.invite!),/expired/);assert.throws(()=>f.repo.play(start.id),/expired/);
    const pipe=new Pipeline(f.repo,f.store,{model:'d',async describe(){return 'x';}},{model:'g',async generate(){return Buffer.from('x');}},async b=>b);
    await pipe.cleanup();assert.equal(f.store.files.size,0);assert.equal(f.repo.list('questions',draft.id).length,0);assert.equal(f.repo.list<Play>('plays',g.id).length,0);
  }finally{f.close();}
});
test('removed in-flight generations cannot recreate a question or leave images', async () => {
  const f=fixture();try {
    const g=f.repo.create('Remove'),q=f.repo.acceptUpload(g.id);q.description='saved';q.state='generate';f.repo.save('questions',q);
    let finish!: (b:Buffer)=>void;
    const pipe=new Pipeline(f.repo,f.store,{model:'d',async describe(){return 'x';}},{model:'g',generate(){return new Promise<Buffer>(r=>{finish=r;});}},async b=>b);
    const pending=pipe.tick();await new Promise(r=>setImmediate(r));f.repo.remove(q.id);finish(Buffer.from('late'));await pending;await pipe.cleanup();
    assert.equal(f.repo.get('questions',q.id),undefined);assert.equal(f.store.files.size,0);
  }finally{f.close();}
});
test('invalid or interrupted uploads release unused capacity', () => {
  const f=fixture(1040);try {
    const g=f.repo.create('Uploads'),q=f.repo.acceptUpload(g.id);assert.equal(f.repo.budget().reserved,1040);
    f.repo.cancelUpload(q.id);assert.equal(f.repo.budget().reserved,0);assert.equal(f.repo.get('questions',q.id),undefined);assert.ok(f.repo.acceptUpload(g.id));
  }finally{f.close();}
});
test('jobs reserve new-day capacity before provider calls after rollover', async () => {
  const f=fixture(1040);try {
    const g=f.repo.create('Rollover'),q=f.repo.acceptUpload(g.id);q.state='describe';f.repo.save('questions',q);await f.store.put(q.original,Buffer.from('x'));f.advance(86400000);
    const other=f.repo.create('New day');f.repo.acceptUpload(other.id);let calls=0;
    const pipe=new Pipeline(f.repo,f.store,{model:'d',async describe(){calls++;return 'x';}},{model:'g',async generate(){return Buffer.from('x');}},async b=>b);
    assert.equal(await pipe.tick(),false);assert.equal(calls,0);f.advance(86400000);assert.equal(await pipe.tick(),true);assert.equal(calls,1);
  }finally{f.close();}
});
