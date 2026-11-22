import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  API_IMAGE,
  PG_IMAGE,
  MINIO_IMAGE,
  docker,
  isMain,
  privatePath,
  save,
} from './operational-common.js';

export async function verify(manifest, inspect = docker) {
  await privatePath(dirname(manifest), true);
  await privatePath(manifest);
  const data = JSON.parse(await readFile(manifest, 'utf8')),
    run = data.runId;
  assert.match(run, /^[a-f0-9]{8,32}$/);
  const prefix = `feature005-test-${run}`;
  assert.equal(data.network, `${prefix}-network`);
  assert.equal(data.database, `feature005_test_${run}`);
  assert.equal(data.bucket, prefix);
  assert.equal(data.postgresImage, PG_IMAGE);
  assert.equal(data.minioImage, MINIO_IMAGE);
  assert.equal(data.apiImage, API_IMAGE);
  const output = {},
    ids = [];
  for (const [service, image, destination] of [
    ['postgres', PG_IMAGE, '/var/lib/postgresql/data'],
    ['minio', MINIO_IMAGE, '/data'],
  ]) {
    const name = `${prefix}-${service}`,
      volume = `${name}-data`;
    assert.equal(data[`${service}Container`], name);
    assert.equal(data[`${service}Volume`], volume);
    const [item] = JSON.parse(await inspect(['inspect', name]));
    assert.equal(item.Id, data[`${service}Id`]);
    assert.equal(item.Image, image);
    assert.equal(item.Config.Labels['io.alvesglass.feature005.run'], run);
    assert.equal(item.State.Running, true);
    assert.equal(item.State.OOMKilled, false);
    assert.deepEqual(Object.keys(item.NetworkSettings.Networks), [
      data.network,
    ]);
    const config = item.HostConfig;
    assert.equal(Object.keys(config.PortBindings ?? {}).length, 0);
    assert.equal(item.Mounts.length, 1);
    const mount = item.Mounts[0];
    assert.equal(mount.Type, 'volume');
    assert.equal(mount.Name, volume);
    assert.equal(mount.Destination, destination);
    assert.equal(config.Memory, 536870912);
    assert.equal(config.MemorySwap, 536870912);
    assert.equal(config.NanoCpus, 1000000000);
    assert.equal(config.PidsLimit, 64);
    assert.equal(config.RestartPolicy.Name, 'no');
    assert.ok(config.SecurityOpt.includes('no-new-privileges'));
    const [info] = JSON.parse(await inspect(['volume', 'inspect', volume]));
    assert.equal(info.Labels['io.alvesglass.feature005.run'], run);
    ids.push(item.Id);
    output[service] = {
      id: item.Id,
      image,
      volume,
      network: data.network,
      portsPublished: false,
      memoryBytes: config.Memory,
      cpus: 1,
      pids: 64,
      running: true,
    };
  }
  const [network] = JSON.parse(
    await inspect(['network', 'inspect', data.network]),
  );
  assert.equal(network.Internal, true);
  assert.deepEqual(Object.keys(network.Containers).sort(), ids.sort());
  assert.equal(network.Labels['io.alvesglass.feature005.run'], run);
  output.network = {
    id: network.Id,
    name: data.network,
    internal: true,
    containers: ids,
  };
  await save(join(dirname(manifest), 'infrastructure.json'), output);
  console.log('FEATURE005_T021_DOCKER_IDENTITIES_VERIFIED');
  return data;
}
if (isMain(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3);
    await verify(process.argv[2]);
  } catch {
    console.error('FEATURE005_DOCKER_PREFLIGHT_FAILED');
    process.exitCode = 20;
  }
}
