// T007: real PostgreSQL only, deliberately not runnable until T011/T012/T021.
// T021 must provision an EMPTY public schema and a remote identity record in
// feature005_test_identity.receipt(run_id text, token_sha256 text).
// Run on PostgreSQL 17 only; never reset/drop a database here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { requireBudgetTestEnvironment } from '../../support/budgets/environment.js';

const root = new URL('../../../', import.meta.url);
const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const baseline = '20261126000000-add-service-order-informational-priority.cjs';
const names = [
  '20261127000000-create-budget-commercial-authorization.cjs',
  '20261128000000-create-budget-pdf-objects.cjs',
  '20261129000000-create-budgets-pdf.cjs',
];

test('T007 schema fresh chain + legacy upgrade + constraints + protected rollback (PG17)', async () => {
  // All local blockers precede pg/Sequelize import and any socket creation.
  const target = requireBudgetTestEnvironment(process.env);
  const files = readdirSync(new URL('src/database/migrations/', root));
  const lifecycle = files.find((file) =>
    file.endsWith('-enforce-budget-pdf-lifecycle.cjs'),
  );
  assert.ok(lifecycle, 'T007_BLOCKED_T011_REQUIRED');
  assert.ok(
    existsSync(new URL('src/app/models/BudgetPdf.js', root)),
    'T007_BLOCKED_T012_REQUIRED',
  );
  assert.equal(
    process.env.BUDGETS_SCHEMA_EXECUTION_APPROVED,
    '1',
    'T007_BLOCKED_T021_AUTHORIZATION_REQUIRED',
  );
  const nonce = process.env.BUDGETS_TEST_IDENTITY_TOKEN;
  assert.match(
    nonce ?? '',
    /^[a-f0-9]{64}$/,
    'T007_BLOCKED_T021_IDENTITY_REQUIRED',
  );
  assert.ok(
    process.env.BUDGETS_TEST_POSTGRES_MAJOR === '17',
    'T007_BLOCKED_POSTGRES_17_REQUIRED',
  );
  const { Sequelize } = await import('sequelize');
  const db = new Sequelize(
    target.database,
    process.env.DB_USERNAME,
    process.env.DB_PASSWORD,
    {
      host: target.postgres.host,
      port: target.postgres.port,
      dialect: 'postgres',
      logging: false,
      pool: { max: 1 },
      dialectOptions: { connectionTimeoutMillis: 5000 },
    },
  );
  const rows = async (sql, replacements = {}) =>
    (await db.query(sql, { replacements }))[0];
  try {
    // Authenticated remote identity, current owner and privileges, not just names.
    const [identity] =
      await rows(`SELECT current_database() AS database, current_user AS username,
      current_setting('server_version_num')::integer / 10000 AS major,
      r.rolsuper, r.rolcreatedb, r.rolcreaterole,
      pg_get_userbyid(d.datdba) AS owner FROM pg_roles r
      JOIN pg_database d ON d.datname = current_database() WHERE r.rolname = current_user`);
    assert.equal(identity.database, target.database);
    assert.equal(identity.username, process.env.DB_USERNAME);
    assert.equal(identity.owner, identity.username);
    assert.equal(
      String(identity.major),
      process.env.BUDGETS_TEST_POSTGRES_MAJOR,
    );
    for (const field of ['rolsuper', 'rolcreatedb', 'rolcreaterole'])
      assert.equal(identity[field], false);
    const receipts = await rows(
      'SELECT run_id, token_sha256 FROM feature005_test_identity.receipt',
    );
    assert.deepEqual(receipts, [
      {
        run_id: target.runId,
        token_sha256: createHash('sha256').update(nonce).digest('hex'),
      },
    ]);
    const existing = await rows(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    if (existing.length) {
      assert.equal(
        process.env.BUDGETS_RESUME_BASELINE_APPROVED,
        '1',
        'REFUSE_NONEMPTY_DATABASE',
      );
      const meta = await rows(
        'SELECT name FROM public."SequelizeMeta" ORDER BY name',
      );
      assert.equal(meta.at(-1)?.name, baseline, 'RESUME_ONLY_EXACT_BASELINE');
      for (const table of ['users', 'client', 'sectors', 'budget']) {
        assert.equal(
          Number(
            (await rows(`SELECT count(*) AS n FROM public.${table}`))[0].n,
          ),
          0,
          'RESUME_REQUIRES_EMPTY_FIXTURES',
        );
      }
    }

    const cliEnv = Object.fromEntries(
      [
        'PATH',
        'HOME',
        'DB_HOST',
        'DB_PORT',
        'DB_DATABASE',
        'DB_USERNAME',
        'DB_PASSWORD',
      ].map((key) => [key, process.env[key]]),
    );
    cliEnv.NODE_ENV = 'test';
    const migrate = async (to) => {
      try {
        await execute(
          process.execPath,
          [
            new URL('node_modules/sequelize-cli/lib/sequelize', root).pathname,
            'db:migrate',
            '--env',
            'test',
            '--to',
            to,
          ],
          {
            cwd: root.pathname,
            env: cliEnv,
            timeout: 120000,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch {
        // Never echo CLI configuration, connection errors or credentials.
        throw new Error('BUDGET_SCHEMA_CLI_FAILED');
      }
    };
    await migrate(baseline); // fresh historical chain, not sync/createTable
    if (process.env.BUDGETS_INTEGRATION_SCENARIO === 'fresh') {
      assert.equal(existing.length, 0, 'FRESH_FIXTURE_MUST_START_EMPTY');
      await migrate(lifecycle);
      const applied = await rows(
        'SELECT name FROM public."SequelizeMeta" ORDER BY name',
      );
      for (const name of [...names, lifecycle])
        assert.ok(applied.some((row) => row.name === name));
      for (const table of [
        'budgets_pdf',
        'budget_pdf_objects',
        'budget_commercial_managers',
        'budget_commercial_permissions',
        'budget_commercial_permission_audit',
      ])
        assert.equal(
          (await rows(`SELECT count(*) AS n FROM public.${table}`))[0].n,
          '0',
        );
      return;
    }
    // Empty rollback is authorized only in a separately provisioned disposable
    // fixture, never the main T021 database or a populated domain.
    if (process.env.BUDGETS_EMPTY_ROLLBACK_FIXTURE_APPROVED === '1') {
      assert.equal(existing.length, 0, 'ROLLBACK_FIXTURE_MUST_START_EMPTY');
      await migrate(lifecycle);
      for (const name of [...names, lifecycle].reverse()) {
        const result = await execute(
          process.execPath,
          [
            new URL('node_modules/sequelize-cli/lib/sequelize', root).pathname,
            'db:migrate:undo',
            '--env',
            'test',
          ],
          { cwd: root.pathname, env: cliEnv, timeout: 120000 },
        );
        assert.ok(result.stdout.includes(name.replace(/\.cjs$/, '')));
        assert.equal(
          (
            await rows(
              'SELECT name FROM public."SequelizeMeta" WHERE name=:name',
              { name },
            )
          ).length,
          0,
        );
      }
      assert.deepEqual(
        await rows(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'budget%'",
        ),
        [{ tablename: 'budget' }],
      );
    }
    const user = randomUUID(),
      client = randomUUID(),
      sector = randomUUID(),
      legacy = randomUUID();
    await rows(
      `INSERT INTO public.users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
      VALUES (:user,'synthetic-foundation','synthetic-foundation@example.invalid','not-a-password','admin','active','',now(),now())`,
      { user },
    );
    await rows(
      `INSERT INTO public.client(id,name,email,phone,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at)
      VALUES (:client,'synthetic-client','synthetic-client@example.invalid','0','0','synthetic','0','synthetic','synthetic','SP',now(),now())`,
      { client },
    );
    await rows(
      "INSERT INTO public.sectors(id,code,name,created_at,updated_at) VALUES (:sector,'BUDGET_TEST','synthetic-sector',now(),now())",
      { sector },
    );
    await rows(
      `INSERT INTO public.budget(id,client_id,name_budget,description_budget,expiration_date,total_value,created_at,updated_at)
      VALUES (:legacy,:client,'synthetic legacy','synthetic legacy quarantine','2027-01-01T00:00:00Z',123.45,now(),now())`,
      { legacy, client },
    );
    const before = await rows(
      'SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id',
    );
    await migrate(lifecycle); // upgrade with real old fixtures; T011 is mandatory
    assert.deepEqual(
      await rows(
        'SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id',
      ),
      before,
    );
    const applied = await rows(
      'SELECT name FROM public."SequelizeMeta" ORDER BY name',
    );
    for (const name of [...names, lifecycle])
      assert.ok(applied.some((row) => row.name === name));

    const object = randomUUID(),
      budget = randomUUID();
    const replacements = { user, client, sector, object, budget };
    await db.transaction(async (transaction) => {
      await db.query(
        `INSERT INTO public.budget_pdf_objects
        (id,owner_budget_id,bucket,object_key,created_by,state,validity_date,lease_token,lease_until)
        VALUES (:object,:budget,'synthetic-private',:object,:user,'UPLOADING','2027-01-01',:token,now()+interval '2 minutes')`,
        { transaction, replacements: { ...replacements, token: randomUUID() } },
      );
      await db.query(
        `UPDATE public.budget_pdf_objects SET state='READY',size_bytes=381,sha256=repeat('a',64),
        content_type='application/pdf',confirmed_at=now() WHERE id=:object`,
        { transaction, replacements },
      );
      await db.query(
        `INSERT INTO public.budgets_pdf
        (id,client_id,sector_id,created_by,commercial_number,administrative_name,pending_object_id,pending_validity_date)
        VALUES (:budget,:client,:sector,:user,'00042','synthetic',:object,'2027-01-01')`,
        { transaction, replacements },
      );
      await db.query(
        "UPDATE public.budget_pdf_objects SET state='ATTACHED' WHERE id=:object",
        { transaction, replacements },
      );
    });
    const rejectsSQL = async (sql, expectedCode, extra = {}) => {
      await assert.rejects(
        db.transaction(async (transaction) => {
          await db.query(sql, {
            transaction,
            replacements: { ...replacements, ...extra },
          });
          await db.query('SET CONSTRAINTS ALL IMMEDIATE', { transaction });
        }),
        (error) => error.original?.code === expectedCode,
      );
    };
    for (const assignment of [
      'revision=0',
      'pending_validity_date=NULL',
      'pending_object_id=NULL',
      "commercial_number=' 42'",
      "administrative_name=''",
      'published_object_id=pending_object_id,published_validity_date=pending_validity_date,first_published_at=now()',
    ])
      await rejectsSQL(
        `UPDATE public.budgets_pdf SET ${assignment} WHERE id=:budget`,
        '23514',
      );
    await rejectsSQL(
      'UPDATE public.budgets_pdf SET client_id=:absent,revision=revision+1 WHERE id=:budget',
      '23503',
      { absent: randomUUID() },
    );
    await rejectsSQL('DELETE FROM public.users WHERE id=:user', '23503');
    await rejectsSQL('DELETE FROM public.client WHERE id=:client', '23503');
    await rejectsSQL('DELETE FROM public.sectors WHERE id=:sector', '23503');
    for (const assignment of [
      'size_bytes=NULL',
      'size_bytes=10485761',
      "sha256='invalid'",
      "content_type='text/plain'",
    ])
      await rejectsSQL(
        `UPDATE public.budget_pdf_objects SET ${assignment} WHERE id=:object`,
        '23514',
      );
    // Composite ownership and uniqueness must be checked by the real server.
    await assert.rejects(
      db.transaction(async (transaction) => {
        const extra = {
          ...replacements,
          other: randomUUID(),
          candidate: randomUUID(),
          token: randomUUID(),
        };
        const query = (sql) =>
          db.query(sql, { transaction, replacements: extra });
        await query(`INSERT INTO public.budget_pdf_objects(id,owner_budget_id,bucket,object_key,created_by,state,validity_date,lease_token,lease_until)
        VALUES (:candidate,:other,'synthetic-private',:candidate,:user,'UPLOADING','2027-01-01',:token,now()+interval '2 minutes')`);
        await query(
          `UPDATE public.budget_pdf_objects SET state='READY',size_bytes=381,sha256=repeat('a',64),content_type='application/pdf',confirmed_at=now() WHERE id=:candidate`,
        );
        await query(`INSERT INTO public.budgets_pdf(id,client_id,sector_id,created_by,commercial_number,administrative_name,pending_object_id,pending_validity_date)
        VALUES (:other,:client,:sector,:user,'00042','synthetic duplicate',:candidate,'2027-01-01')`);
      }),
      (error) => error.original?.code === '23505',
    );
    await rejectsSQL(
      `INSERT INTO public.budget_pdf_objects
      (id,owner_budget_id,bucket,object_key,created_by,state,validity_date,lease_token,lease_until)
      SELECT :other,owner_budget_id,bucket,object_key,created_by,'UPLOADING',validity_date,:token,now()+interval '2 minutes'
      FROM public.budget_pdf_objects WHERE id=:object`,
      '23505',
      { other: randomUUID(), token: randomUUID() },
    );
    for (const assignment of [
      'id=:other',
      'created_by=:other',
      "created_at=created_at-interval '1 second'",
    ])
      await rejectsSQL(
        `UPDATE public.budgets_pdf SET ${assignment},revision=revision+1 WHERE id=:budget`,
        '23514',
        { other: randomUUID() },
      );
    // T011 must make the complete lifecycle enforceable before this can run.
    await rows(
      `UPDATE public.budgets_pdf SET published_object_id=pending_object_id,
      published_validity_date=pending_validity_date,pending_object_id=NULL,pending_validity_date=NULL,
      first_published_at=now(),revision=revision+1 WHERE id=:budget`,
      { budget },
    );
    for (const assignment of [
      "commercial_number='42'",
      'first_published_at=NULL',
      "first_published_at=first_published_at+interval '1 second'",
      'revision=revision',
    ])
      await rejectsSQL(
        `UPDATE public.budgets_pdf SET ${assignment} WHERE id=:budget`,
        '23514',
      );
    await rejectsSQL(
      `UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING' WHERE id=:object`,
      '23514',
    );
    const [constraints] = await rows(`SELECT
      count(*) FILTER (WHERE contype='f' AND condeferrable AND condeferred) AS deferred_owners,
      count(*) FILTER (WHERE contype='c') AS checks
      FROM pg_constraint WHERE conrelid='public.budgets_pdf'::regclass`);
    assert.equal(Number(constraints.deferred_owners), 2);
    assert.ok(Number(constraints.checks) >= 9);
    const indexes = await rows(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='budgets_pdf'",
    );
    for (const name of [
      'budgets_pdf_number_uq',
      'budgets_pdf_pending_slot_uq',
      'budgets_pdf_published_slot_uq',
      'budgets_pdf_sector_keyset_idx',
      'budgets_pdf_client_keyset_idx',
    ])
      assert.ok(indexes.some((row) => row.indexname === name));
    const [definition] =
      await rows(`SELECT collation_name,character_maximum_length,is_nullable
      FROM information_schema.columns WHERE table_schema='public' AND table_name='budgets_pdf' AND column_name='commercial_number'`);
    assert.equal(definition.collation_name, 'C');
    assert.equal(definition.character_maximum_length, 64);
    assert.equal(definition.is_nullable, 'NO');
    const audit = randomUUID(),
      targetUser = randomUUID();
    await rows(
      `INSERT INTO public.users(id,name,email,password_hash,update_number,created_at,updated_at) VALUES (:targetUser,'synthetic-target','synthetic-target@example.invalid','not-a-password','',now(),now())`,
      { targetUser },
    );
    for (const operation of [
      'CREATE_EDIT',
      'READ',
      'REPLACE_PDF',
      'PUBLISH',
      'DELETE',
      'MANAGE_PERMISSIONS',
    ]) {
      await rows(
        `INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by)
        VALUES (:targetUser,:sector,:operation,:user)`,
        { targetUser, sector, operation, user },
      );
    }
    await rejectsSQL(
      `INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by)
      VALUES (:targetUser,:sector,'UNKNOWN',:user)`,
      '23514',
      { targetUser },
    );
    await rejectsSQL(
      `INSERT INTO public.budget_commercial_permissions(user_id,sector_id,operation,granted_by)
      VALUES (:targetUser,:sector,'READ',:user)`,
      '23505',
      { targetUser },
    );
    await rows(
      `INSERT INTO public.budget_commercial_permission_audit(id,actor_user_id,target_user_id,sector_id,action,operation)
      VALUES (:audit,:user,:targetUser,:sector,'GRANT','READ')`,
      { audit, user, targetUser, sector },
    );
    for (const sql of [
      'DELETE FROM public.budget_commercial_permission_audit',
      'UPDATE public.budget_commercial_permission_audit SET occurred_at=now()',
      'TRUNCATE public.budget_commercial_permission_audit',
    ])
      await rejectsSQL(sql, '23514');
    for (const name of [...names, lifecycle].reverse()) {
      const migration = require(
        new URL(`src/database/migrations/${name}`, root).pathname,
      );
      await assert.rejects(
        migration.down(db.getQueryInterface()),
        /BUDGET_ROLLBACK_REQUIRES_EMPTY_TABLES/,
      );
    }
    assert.deepEqual(
      await rows(
        'SELECT to_jsonb(b) AS value FROM public.budget b ORDER BY id',
      ),
      before,
    );
    // Deliberately retain all synthetic records for evidence; no destructive reset.
  } finally {
    await db.close();
  }
});
