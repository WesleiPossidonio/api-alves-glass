import { randomUUID } from 'node:crypto';

// Identities exist only inside the caller's rollback-only PostgreSQL transaction.
export async function createRecoveryIdentityFixture(sql, transaction) {
  const id = randomUUID();
  const [user] = await sql(
    `INSERT INTO users (id,name,email,password_hash,role,status_users,update_number,created_at,updated_at)
     VALUES ($1,$2,$3,'recovery-test-only','user','active','',now(),now()) RETURNING id`,
    [randomUUID(), `Recovery ${id}`, `recovery-${id}@users.test`],
    transaction,
  );
  const [sector] = await sql(
    'INSERT INTO sectors (id,code,name,created_at,updated_at) VALUES ($1,$2,$3,now(),now()) RETURNING id',
    [randomUUID(), `RF${id.slice(0, 24)}`, `Recovery ${id}`],
    transaction,
  );
  const clients = [];
  for (const index of [0, 1]) {
    const [client] = await sql(
      `INSERT INTO client (id,name,email,phone,client_status,cep,rua,number_house,bairro,cidade,uf,created_at,updated_at)
       VALUES ($1,$2,$3,'555','active','00000','Test','1','Test','Test','SP',now(),now()) RETURNING id`,
      [randomUUID(), `Recovery ${id} ${index}`, `recovery-${id}-${index}@clients.test`],
      transaction,
    );
    clients.push(client);
  }
  const [order] = await sql(
    `INSERT INTO service_orders
       (id,external_number,client_id,sector_id,due_at,public_status,
        administrative_state,operational_version,queue_entered_at,production_completed,created_by,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'CREATED','ACTIVE',0,now(),false,$6,now(),now())
     RETURNING client_id,sector_id,created_by`,
    [randomUUID(), `RF-${id}`, clients[0].id, sector.id, '2027-01-02T00:00:00Z', user.id],
    transaction,
  );
  return { reference: order, other: clients[1] };
}