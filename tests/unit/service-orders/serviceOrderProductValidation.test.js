import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateProductMeasurements,
  validateServiceOrderRegistration,
} from '../../../src/app/services/serviceOrderDomain.js';

const registration = (product) => ({
  clientId: 'client',
  sectorId: 'sector',
  externalNumber: 'RF07-001',
  dueAt: '2026-12-01',
  products: [product],
});
const minimalProduct = () => ({
  name: 'Vidro e ferro sob medida',
  quantity: 1,
  measurements: { width: '001.2500', height: 2 },
});

test('RF07 registration needs only name, quantity, width and height, without material inference', () => {
  const product = minimalProduct();
  const before = structuredClone(product);
  assert.equal(validateServiceOrderRegistration(registration(product)), true);
  assert.deepEqual(product, before);
});

test('registration description respects the existing model and PostgreSQL limit', () => {
  assert.equal(
    validateServiceOrderRegistration(
      registration({ ...minimalProduct(), description: 'x'.repeat(2000) }),
    ),
    true,
  );
  assert.throws(
    () =>
      validateServiceOrderRegistration(
        registration({ ...minimalProduct(), description: 'x'.repeat(2001) }),
      ),
    { code: 'productDescriptionInvalid' },
  );
});

test('RF07 optional specifications and historical JSON formats are preserved without unit conversion', () => {
  for (const measurements of [
    {
      width: ' +001.2500 ',
      height: '2e2',
      thickness: '.006',
      glassColor: 'Cristal artesanal',
      aluminumColor: 'RAL customizado',
      ironColor: 'Grafite fosco',
    },
    {
      widthMm: '1200.125',
      heightMm: 800,
      thicknessMm: '06.00',
      glassColor: '#abc123',
      profile: { riseMm: '42.75' },
      finish: ['polished'],
    },
    { width: 1, widthMm: '1000', height: 2, heightMm: '2000' },
  ]) {
    const product = { ...minimalProduct(), measurements };
    const before = structuredClone(product);
    assert.equal(validateServiceOrderRegistration(registration(product)), true);
    assert.deepEqual(product, before);
  }
});

test('RF07 registration rejects empty names and invalid quantities', () => {
  for (const name of [undefined, null, '', ' \t ', 42])
    assert.throws(
      () =>
        validateServiceOrderRegistration(
          registration({ ...minimalProduct(), name }),
        ),
      { code: 'productNameRequired' },
    );
  for (const quantity of [
    undefined,
    null,
    0,
    -1,
    1.5,
    '2',
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () =>
        validateServiceOrderRegistration(
          registration({ ...minimalProduct(), quantity }),
        ),
      { code: 'quantityMustBePositiveInteger' },
    );
});

test('RF07 both dimension alias families require finite positive numeric values at registration and correction', () => {
  for (const key of ['width', 'widthMm', 'height', 'heightMm']) {
    const base = key.startsWith('width') ? { height: 2 } : { width: 1 };
    for (const value of [
      undefined,
      null,
      '',
      ' ',
      0,
      -1,
      '-0',
      '-.1',
      NaN,
      Infinity,
      -Infinity,
      'NaN',
      'Infinity',
      '1e999',
      '1e-999',
      '12mm',
      '1,25',
      '0x10',
      true,
      [],
      {},
    ]) {
      const measurements = { ...base, [key]: value };
      assert.throws(() => validateProductMeasurements(measurements));
      assert.throws(() =>
        validateServiceOrderRegistration(
          registration({ ...minimalProduct(), measurements }),
        ),
      );
    }
    assert.throws(
      () =>
        validateServiceOrderRegistration(
          registration({ ...minimalProduct(), measurements: base }),
        ),
      { code: 'widthAndHeightRequired' },
    );
  }
  assert.throws(
    () => validateProductMeasurements({ width: 1, widthMm: -1, height: 2 }),
    { code: 'dimensionMustBeValidNumber' },
  );
});

test('RF07 supplied thickness is optional but must be numeric, finite and positive', () => {
  for (const key of ['thickness', 'thicknessMm'])
    for (const value of [
      undefined,
      null,
      '',
      ' ',
      0,
      -1,
      NaN,
      Infinity,
      'NaN',
      '1e999',
      '6mm',
      true,
      [],
      {},
    ]) {
      const measurements = { width: 1, height: 2, [key]: value };
      assert.throws(() => validateProductMeasurements(measurements), {
        code: 'dimensionMustBeValidNumber',
      });
      assert.throws(
        () =>
          validateServiceOrderRegistration(
            registration({ ...minimalProduct(), measurements }),
          ),
        { code: 'dimensionMustBeValidNumber' },
      );
    }
});

test('RF07 optional colors accept free text, but reject non-text and blank values', () => {
  for (const key of ['glassColor', 'aluminumColor', 'ironColor'])
    for (const value of [undefined, null, '', ' \t ', 12, true, [], {}]) {
      const measurements = { width: 1, height: 2, [key]: value };
      assert.throws(() => validateProductMeasurements(measurements), {
        code: 'productColorInvalid',
      });
      assert.throws(
        () =>
          validateServiceOrderRegistration(
            registration({ ...minimalProduct(), measurements }),
          ),
        { code: 'productColorInvalid' },
      );
    }
});
