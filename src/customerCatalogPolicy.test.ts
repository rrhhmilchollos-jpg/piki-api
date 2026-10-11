import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_CATALOG_RESTAURANT_FILTER, CUSTOMER_ORDERABLE_RESTAURANT_FILTER, COMING_SOON_SLUGS, presentCustomerCatalogRestaurant } from './customerCatalogPolicy.js';

test('los cinco partners próximos son visibles pero no se incluyen en el filtro operable', () => {
  assert.equal(COMING_SOON_SLUGS.length, 5);
  assert.deepEqual(CUSTOMER_CATALOG_RESTAURANT_FILTER.$or[1].slug.$in, [...COMING_SOON_SLUGS]);
  assert.equal(CUSTOMER_ORDERABLE_RESTAURANT_FILTER.availabilityStatus.$ne, 'coming_soon');
  for (const slug of COMING_SOON_SLUGS) {
    assert.equal(CUSTOMER_ORDERABLE_RESTAURANT_FILTER.slug.$in.includes(slug), false);
    const view = presentCustomerCatalogRestaurant({name: slug, slug, availabilityStatus:'coming_soon'});
    assert.equal(view.orderable, false);
    assert.equal(view.availabilityLabel, 'Disponible muy pronto');
  }
});
