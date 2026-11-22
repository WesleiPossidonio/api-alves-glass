import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openBudgetGateEnvironment } from './gate-environment.js';
import Budget from '../../../src/app/models/BudgetPdf.js';
import ObjectModel from '../../../src/app/models/BudgetPdfObject.js';
import Manager from '../../../src/app/models/BudgetCommercialManager.js';
import Permission from '../../../src/app/models/BudgetCommercialPermission.js';
import Audit from '../../../src/app/models/BudgetCommercialPermissionAudit.js';
import { BudgetPdfRepositoryClient } from '../../../src/app/repositories/BudgetPdfRepository.js';
import { BudgetPdfObjectRepositoryClient } from '../../../src/app/repositories/BudgetPdfObjectRepository.js';
import { BudgetCommercialAuthorizationRepositoryClient } from '../../../src/app/repositories/BudgetCommercialAuthorizationRepository.js';
import { createBudgetAuthorizationService } from '../../../src/app/services/BudgetAuthorizationService.js';
import { BudgetPdfStorageServiceClient } from '../../../src/app/services/BudgetPdfStorageService.js';
import { createBudgetPdfCleanupWorker } from '../../../src/app/services/BudgetPdfCleanupWorker.js';
import { buildPdf } from '../../fixtures/budgets/build-fixtures.js';

export async function matrixFixture() {
  const connection = await openBudgetGateEnvironment();
  const { db, rows } = connection;
  for (const model of [Budget, ObjectModel, Manager, Permission, Audit])
    model.init(db);
  const budgets = new BudgetPdfRepositoryClient(),
    objects = new BudgetPdfObjectRepositoryClient();
  const authRepository = new BudgetCommercialAuthorizationRepositoryClient();
  const authorization = createBudgetAuthorizationService({
    repository: authRepository,
  });
  const storage = new BudgetPdfStorageServiceClient({ repository: objects });
  const worker = createBudgetPdfCleanupWorker({ repository: objects, storage });
  const tx = (fn) => objects.transaction(fn);
  async function user(role = 'user') {
    const id = randomUUID();
    await rows(
      `INSERT INTO public.users(id,name,email,password_hash,role,status_users,update_number,created_at,updated_at) VALUES (:id,:id,:email,'not-a-password',:role,'active','',now(),now())`,
      { id, role, email: `${id}@example.invalid` },
    );
    return id;
  }
  async function sector() {
    const id = randomUUID();
    await rows(
      'INSERT INTO public.sectors(id,code,name,created_at,updated_at) VALUES (:id,:code,:id,now(),now())',
      { id, code: id.replaceAll('-', '') },
    );
    return id;
  }
  async function client() {
    const id = randomUUID();
    await rows(
      `INSERT INTO public.client(id,name,email,phone,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at) VALUES (:id,:id,:email,'0','0','synthetic','0','synthetic','synthetic','SP',now(),now())`,
      { id, email: `${id}@example.invalid` },
    );
    return id;
  }
  const technical = await user(),
    creator = await user('admin'),
    sectorId = await sector(),
    clientId = await client();
  async function intent({
    owner = randomUUID(),
    revision = null,
    adapter = storage,
    bytes = buildPdf(),
    date = '2027-01-01',
  } = {}) {
    const proof = await adapter.prepare(bytes, owner),
      token = randomUUID();
    await tx((transaction) =>
      objects.createIntent(
        {
          ...proof,
          created_by: technical,
          validity_date: date,
          expected_revision: revision,
          lease_token: token,
          lease_until: new Date(Date.now() + 120000),
        },
        transaction,
      ),
    );
    return { proof, token, date, adapter };
  }
  async function ready(item, transaction) {
    await objects.lockOwned(item.proof, transaction);
    return objects.compareAndSwapLease(
      {
        id: item.proof.id,
        token: item.token,
        state: 'UPLOADING',
        nextState: 'READY',
        values: {
          size_bytes: item.proof.size_bytes,
          sha256: item.proof.sha256,
          content_type: 'application/pdf',
          confirmed_at: new Date(),
        },
      },
      transaction,
    );
  }
  async function attach(
    item,
    {
      number = randomUUID(),
      sector = sectorId,
      client = clientId,
      transaction,
    } = {},
  ) {
    const work = async (transaction) => {
      await ready(item, transaction);
      await budgets.create(
        {
          id: item.proof.owner_budget_id,
          client_id: client,
          sector_id: sector,
          created_by: creator,
          commercial_number: number,
          administrative_name: 'T022 matrix synthetic',
          pending_object_id: item.proof.id,
          pending_validity_date: item.date,
        },
        transaction,
      );
      await rows(
        "UPDATE public.budget_pdf_objects SET state='ATTACHED' WHERE id=:id",
        { id: item.proof.id },
        transaction,
      );
    };
    return transaction ? work(transaction) : tx(work);
  }
  async function attached(options = {}) {
    const item = await intent(options);
    await item.adapter.upload(item.proof, item.token);
    await attach(item, options);
    return item;
  }
  async function detach(item, transaction) {
    await objects.lockOwned(item.proof, transaction);
    await budgets.remove(
      item.proof.owner_budget_id,
      String(
        (await Budget.findByPk(item.proof.owner_budget_id, { transaction }))
          .revision,
      ),
      transaction,
    );
    await rows(
      "UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',lease_token=NULL,lease_until=NULL WHERE id=:id",
      { id: item.proof.id },
      transaction,
    );
  }
  async function orphan(item) {
    await tx(async (transaction) => {
      await objects.lockOwned(item.proof, transaction);
      await rows(
        "UPDATE public.budget_pdf_objects SET state='CLEANUP_PENDING',lease_token=NULL,lease_until=NULL WHERE id=:id",
        { id: item.proof.id },
        transaction,
      );
    });
  }
  async function claim(item) {
    const batch = await tx((transaction) => objects.claimCleanup(transaction));
    const job = batch.find((row) => row.id === item.proof.id);
    assert.ok(job, 'exclusive fixture durable claim');
    return job;
  }
  return {
    ...connection,
    Budget,
    ObjectModel,
    budgets,
    objects,
    authRepository,
    authorization,
    storage,
    worker,
    tx,
    user,
    sector,
    client,
    technical,
    creator,
    sectorId,
    clientId,
    intent,
    ready,
    attach,
    attached,
    detach,
    orphan,
    claim,
  };
}

export function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

// Actual lock wait observation, not a sleep-based assertion. A separate session
// queries pg_locks to prove the contender reached a blocked lock acquisition.
export async function waitForLock(rows, pid) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (
      (
        await rows('SELECT 1 FROM pg_locks WHERE pid=:pid AND NOT granted', {
          pid,
        })
      ).length
    )
      return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('EXPECTED_POSTGRES_LOCK_WAITER');
}
