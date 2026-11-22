import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, iamZip } from '../../support/budgets/iam-zip.js';
import {
  privatePath,
  execute,
  save,
  API_IMAGE,
  PG_IMAGE,
  MINIO_IMAGE,
  resourceProvenAbsent,
} from '../../support/budgets/operational-common.js';
import { provision } from '../../support/budgets/provision-isolated.js';
import { main } from '../../support/budgets/operational-runner.js';
import { verify } from '../../support/budgets/verify-resources.js';

test('Node operational opt-ins fail before Docker; sanitized CLI exits', async () => {
  assert.notEqual(process.env.FEATURE005_T021_APPROVED, '1');
  await assert.rejects(provision([]));
  for (const scenario of [
    'fresh',
    'upgrade',
    'all',
    'prepare-schema',
    'unknown',
  ])
    await assert.rejects(main(['--scenario', scenario]));
  const result = await execute(process.execPath, [
    'tests/support/budgets/operational-runner.js',
    '--scenario',
    'migrated',
    '--manifest',
    '/nonexistent/private',
  ]);
  assert.equal(result.code, 20);
  assert.equal(result.output.trim(), 'BUDGET_OPERATIONAL_PREFLIGHT_FAILED');
  const stopped = await execute(process.execPath, [
    'tests/support/budgets/provision-isolated.js',
  ]);
  assert.equal(stopped.code, 1);
  assert.equal(
    stopped.output.trim(),
    'FEATURE005_T021_STOPPED_RESOURCES_PRESERVED',
  );
});
test('collision preflight accepts exact absent resources only, never daemon failure or collisions', () => {
  for (const kind of ['network', 'volume', 'container']) {
    const name = 'feature005-test-abcdef123456-' + kind;
    for (const output of [
      `Error response from daemon: No such ${kind}: ${name}`,
      `Error response from daemon: ${kind} ${name} not found`,
    ])
      assert.equal(resourceProvenAbsent({ code: 1, output }, kind, name), true);
    for (const result of [
      { code: 0, output: '[]' },
      { code: 1, output: 'Cannot connect to the Docker daemon' },
      { code: 1, output: `No such ${kind}: other-run` },
      { code: 21, output: `${kind} ${name} not found` },
    ])
      assert.equal(resourceProvenAbsent(result, kind, name), false);
  }
});
test('Node private artifacts reject public permissions, symlinks and false identity before Docker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'budget-node-guards-'));
  try {
    const file = join(dir, 'resources.json');
    await save(file, { runId: 'bad-run' });
    await privatePath(file);
    let calls = 0;
    await assert.rejects(
      verify(file, async () => {
        calls++;
      }),
    );
    assert.equal(calls, 0);
    await chmod(file, 0o644);
    await assert.rejects(privatePath(file));
    await chmod(file, 0o600);
    const link = join(dir, 'link');
    await symlink(file, link);
    await assert.rejects(privatePath(link));
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('IAM ZIP STORE has valid CRC, filenames, offsets and central directory without dependencies', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const assets = {
    'policies.json': { test: {} },
    'users.json': { test: { status: 'enabled' } },
    'user_mappings.json': { test: { version: 1 } },
  };
  const bytes = iamZip(assets);
  let offset = 0;
  const offsets = [];
  for (const [key, value] of Object.entries(assets)) {
    offsets.push(offset);
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    const size = bytes.readUInt32LE(offset + 18),
      length = bytes.readUInt16LE(offset + 26);
    assert.equal(
      bytes.subarray(offset + 30, offset + 30 + length).toString(),
      `iam-assets/${key}`,
    );
    const data = bytes.subarray(
      offset + 30 + length,
      offset + 30 + length + size,
    );
    assert.equal(bytes.readUInt32LE(offset + 14), crc32(data));
    assert.deepEqual(JSON.parse(data), value);
    offset += 30 + length + size;
  }
  const directory = offset;
  for (const expected of offsets) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt32LE(offset + 42), expected);
    offset += 46 + bytes.readUInt16LE(offset + 28);
  }
  assert.equal(bytes.readUInt32LE(offset), 0x06054b50);
  assert.equal(bytes.readUInt32LE(offset + 16), directory);
  assert.equal(offset + 22, bytes.length);
  assert.throws(() => iamZip({}));
});

test('Docker verifier parity: every original identity/isolation guard rejects tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'budget-node-equivalence-'));
  const run = 'abcdef123456',
    prefix = `feature005-test-${run}`,
    network = `${prefix}-network`;
  const data = {
    runId: run,
    network,
    database: `feature005_test_${run}`,
    bucket: prefix,
    postgresImage: PG_IMAGE,
    minioImage: MINIO_IMAGE,
    apiImage: API_IMAGE,
  };
  const resources = {};
  for (const [service, image, destination] of [
    ['postgres', PG_IMAGE, '/var/lib/postgresql/data'],
    ['minio', MINIO_IMAGE, '/data'],
  ]) {
    const name = `${prefix}-${service}`,
      volume = `${name}-data`,
      id = service + '-id';
    Object.assign(data, {
      [`${service}Container`]: name,
      [`${service}Volume`]: volume,
      [`${service}Id`]: id,
    });
    resources[`inspect ${name}`] = [
      {
        Id: id,
        Image: image,
        Config: { Labels: { 'io.alvesglass.feature005.run': run } },
        State: { Running: true, OOMKilled: false },
        NetworkSettings: { Networks: { [network]: {} } },
        HostConfig: {
          PortBindings: {},
          Memory: 536870912,
          MemorySwap: 536870912,
          NanoCpus: 1000000000,
          PidsLimit: 64,
          RestartPolicy: { Name: 'no' },
          SecurityOpt: ['no-new-privileges'],
        },
        Mounts: [{ Type: 'volume', Name: volume, Destination: destination }],
      },
    ];
    resources[`volume inspect ${volume}`] = [
      { Labels: { 'io.alvesglass.feature005.run': run } },
    ];
  }
  resources[`network inspect ${network}`] = [
    {
      Id: 'network-id',
      Internal: true,
      Containers: { 'postgres-id': {}, 'minio-id': {} },
      Labels: { 'io.alvesglass.feature005.run': run },
    },
  ];
  const file = join(dir, 'resources.json');
  try {
    await save(file, data);
    const check = (state) =>
      verify(file, async (args) => JSON.stringify(state[args.join(' ')]));
    await check(resources);
    for (const service of ['postgres', 'minio']) {
      for (const mutate of [
        (x) => (x.Id = 'other'),
        (x) => (x.Image = 'other'),
        (x) => (x.Config.Labels = {}),
        (x) => (x.State.Running = false),
        (x) => (x.State.OOMKilled = true),
        (x) => (x.NetworkSettings.Networks.extra = {}),
        (x) => (x.HostConfig.PortBindings = { '5432/tcp': [{}] }),
        (x) => x.Mounts.push({}),
        (x) => (x.Mounts[0].Type = 'bind'),
        (x) => (x.Mounts[0].Name = 'foreign'),
        (x) => (x.Mounts[0].Destination = '/wrong'),
        (x) => (x.HostConfig.Memory = 0),
        (x) => (x.HostConfig.MemorySwap = -1),
        (x) => (x.HostConfig.NanoCpus = 0),
        (x) => (x.HostConfig.PidsLimit = 0),
        (x) => (x.HostConfig.RestartPolicy.Name = 'always'),
        (x) => (x.HostConfig.SecurityOpt = []),
      ]) {
        const state = structuredClone(resources);
        mutate(state[`inspect ${prefix}-${service}`][0]);
        await assert.rejects(check(state));
      }
      const state = structuredClone(resources);
      state[`volume inspect ${prefix}-${service}-data`][0].Labels = {};
      await assert.rejects(check(state));
    }
    for (const mutate of [
      (x) => (x.Internal = false),
      (x) => (x.Containers.extra = {}),
      (x) => (x.Labels = {}),
    ]) {
      const state = structuredClone(resources);
      mutate(state[`network inspect ${network}`][0]);
      await assert.rejects(check(state));
    }
    for (const field of [
      'runId',
      'network',
      'database',
      'bucket',
      'postgresImage',
      'minioImage',
      'apiImage',
      'postgresContainer',
      'postgresVolume',
      'minioContainer',
      'minioVolume',
    ]) {
      await save(file, { ...data, [field]: 'foreign' });
      await assert.rejects(check(resources));
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});
