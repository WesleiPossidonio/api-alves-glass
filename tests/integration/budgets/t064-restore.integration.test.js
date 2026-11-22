import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { openBudgetGateEnvironment } from '../../support/budgets/gate-environment.js';
import { budgetObjectKey } from '../../../src/app/services/BudgetPdfStorageService.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');

test('T064 backup source and restored copy preserve legacy, relations and private bytes', async () => {
  const mode = process.env.BUDGETS_T064_MODE;
  assert.ok(['seed', 'restored', 'prepare-job', 'worker-ready', 'worker-done'].includes(mode));
  const f = await openBudgetGateEnvironment();
  const { rows, db, client, target } = f;
  try {
    // Identity/ACL/schema preflight has completed before any write.
    const snapshot = async (table) =>
      rows(`SELECT to_jsonb(t) AS value FROM public.${table} t ORDER BY id`);
    const state = async () => {
      const [legacy, budgets, objects] = await Promise.all([
        snapshot('budget'), snapshot('budgets_pdf'), snapshot('budget_pdf_objects'),
      ]);
      const attached = objects.filter(({ value }) => value.state === 'ATTACHED');
      assert.equal(budgets.length, 1);
      assert.equal(attached.length, 1);
      const object = attached[0].value;
      assert.equal(budgets[0].value.pending_object_id, object.id);
      assert.equal(budgets[0].value.client_id, legacy[0].value.client_id);
      const stream = await client.getObject(target.bucket, object.object_key);
      const chunks = [];
      for await (const part of stream) chunks.push(part);
      const bytes = Buffer.concat(chunks);
      assert.equal(sha(bytes), object.sha256.trim());
      return { legacy, budgets, objects, pdfSha256: sha(bytes) };
    };
    if (mode === 'seed') {
      assert.equal((await snapshot('budget')).length, 0, 'SEED_REQUIRES_EMPTY_LEGACY');
      assert.equal((await snapshot('budgets_pdf')).length, 0, 'SEED_REQUIRES_EMPTY_NEW');
      const user = randomUUID(), sector = randomUUID(), clientId = randomUUID();
      const legacy = randomUUID(), budget = randomUUID(), object = randomUUID();
      const key = budgetObjectKey(budget, object), bytes = buildPdf();
      await rows(`INSERT INTO public.users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
        VALUES (:user,'T064 synthetic',:email,'not-a-password','admin','active','',now(),now())`, { user, email: `${user}@example.invalid` });
      await rows(`INSERT INTO public.client(id,name,email,phone,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at)
        VALUES (:clientId,'T064 synthetic',:email,'0','0','synthetic','0','synthetic','synthetic','SP',now(),now())`, { clientId, email: `${clientId}@example.invalid` });
      await rows(`INSERT INTO public.sectors(id,code,name,created_at,updated_at)
        VALUES (:sector,:code,'T064 synthetic',now(),now())`, { sector, code: sector.replaceAll('-', '') });
      await rows(`INSERT INTO public.budget(id,client_id,name_budget,description_budget,expiration_date,total_value,created_at,updated_at)
        VALUES (:legacy,:clientId,'T064 legacy','quarantined','2027-01-01T00:00:00Z',1,now(),now())`, { legacy, clientId });
      await client.putObject(target.bucket, key, bytes, bytes.length, { 'Content-Type': 'application/pdf' });
      await db.transaction(async (transaction) => {
        const query = (sql, replacements) => db.query(sql, { transaction, replacements });
        const args = { user, sector, clientId, budget, object, key, bucket: target.bucket, hash: sha(bytes), size: bytes.length };
        await query(`INSERT INTO public.budget_pdf_objects(id,owner_budget_id,bucket,object_key,created_by,state,validity_date,lease_token,lease_until)
          VALUES (:object,:budget,:bucket,:key,:user,'UPLOADING','2027-01-01',:object,now()+interval '2 minutes')`, args);
        await query(`UPDATE public.budget_pdf_objects SET state='READY',size_bytes=:size,sha256=:hash,
          content_type='application/pdf',confirmed_at=now(),lease_token=NULL,lease_until=NULL WHERE id=:object`, args);
        await query(`INSERT INTO public.budgets_pdf(id,client_id,sector_id,created_by,commercial_number,administrative_name,pending_object_id,pending_validity_date)
          VALUES (:budget,:clientId,:sector,:user,'00042','T064 synthetic',:object,'2027-01-01')`, args);
        await query("UPDATE public.budget_pdf_objects SET state='ATTACHED' WHERE id=:object", args);
      });
      console.log('T064_SEED_OK');
    }
    if (mode === 'prepare-job') {
      const owner = randomUUID(), object = randomUUID(), key = budgetObjectKey(owner, object);
      const bytes = Buffer.from('T064 exclusive cleanup job');
      await client.putObject(target.bucket, key, bytes);
      const [{ value: budget }] = await snapshot('budgets_pdf');
      await rows(`INSERT INTO public.budget_pdf_objects(id,owner_budget_id,bucket,object_key,created_by,state,validity_date,lease_token,lease_until)
        VALUES (:object,:owner,:bucket,:key,:creator,'UPLOADING','2027-01-01',:token,now()+interval '2 minutes')`,
        { object, owner, bucket: target.bucket, key, creator: budget.created_by, token: randomUUID() });
      await rows(`UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',lease_token=NULL,lease_until=NULL,
        next_attempt_at='2000-01-01' WHERE id=:object`, { object });
      console.log('T064_COPY_EXCLUSIVE_JOB_CREATED');
    }
    const current = await state();
    const record = { counts: Object.fromEntries(['legacy','budgets','objects'].map((name) => [name, current[name].length])),
      hashes: Object.fromEntries(['legacy','budgets','objects','pdfSha256'].map((name) => [name, sha(JSON.stringify(current[name]))])) };
    // The digest includes real row timestamps; a backup/restore mismatch fails.
    if (mode === 'seed') console.log(`T064_SNAPSHOT=${JSON.stringify(record)}`);
    else {
      const expected = JSON.parse(process.env.BUDGETS_T064_SNAPSHOT);
      if (mode === 'restored') assert.deepEqual(record, expected);
      if (mode === 'prepare-job') assert.equal(current.objects.length, expected.counts.objects + 1);
      if (mode === 'worker-ready' || mode === 'worker-done') {
        assert.deepEqual(record.counts.legacy, expected.counts.legacy);
        assert.deepEqual(record.hashes.legacy, expected.hashes.legacy);
        assert.deepEqual(record.hashes.budgets, expected.hashes.budgets);
        const job = current.objects.find(({ value }) => value.state === (mode === 'worker-ready' ? 'CLEANUP_PENDING' : 'REMOVED'));
        assert.ok(job);
        const stream = client.statObject(target.bucket, job.value.object_key);
        if (mode === 'worker-ready') await stream;
        else await assert.rejects(stream, (error) => error.code === 'NotFound');
      }
      console.log(`T064_${mode.toUpperCase().replace('-', '_')}_OK`);
    }
  } finally {
    await db.close();
  }
});